import { beforeEach, describe, expect, it, vi } from "vitest";

type NativeContact = {
  id?: string;
  fullName?: string | null;
  phones?: Array<{ number?: string; label?: string }>;
  emails?: Array<{ address?: string; label?: string }>;
  [field: string]: unknown;
};

const native = vi.hoisted(() => ({
  module: {} as object | null,
  platform: { OS: "ios" },
  contacts: {
    getPermissionsAsync: vi.fn(async () => ({ granted: true })),
    requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
    Contact: {
      getAllDetails: vi.fn(async (_fields: readonly string[]): Promise<NativeContact[]> => []),
      getAll: vi.fn(),
    },
    ContactField: { FULL_NAME: "fullName", PHONES: "phones", EMAILS: "emails" },
  },
}));

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: (name: string) =>
    name === "ExpoContactsNext" ? native.module : null,
}));
vi.mock("react-native", () => ({ Platform: native.platform }));

async function withoutNativeModule() {
  vi.doMock("expo-contacts", () => {
    throw new Error("Cannot find native module 'ExpoContactsNext'");
  });
  vi.resetModules();
  contacts = await import("./dozo-phone-contacts");
}

type ContactsFile = typeof import("./dozo-phone-contacts");
let contacts: ContactsFile;

const person = (fullName: string | null, extra: Partial<NativeContact> = {}): NativeContact => ({
  id: `id-${fullName}`,
  fullName,
  phones: [{ number: "+1 555 0100", label: "mobile" }],
  emails: [{ address: "someone@example.test", label: "work" }],
  ...extra,
});

const phone = { query: "ada", field: "phone" as const, limit: 10 };

beforeEach(async () => {
  vi.resetModules();
  native.module = {};
  native.platform.OS = "ios";
  vi.doMock("expo-contacts", () => native.contacts);
  native.contacts.getPermissionsAsync.mockClear().mockResolvedValue({ granted: true });
  native.contacts.requestPermissionsAsync.mockClear().mockResolvedValue({ granted: true });
  native.contacts.Contact.getAllDetails.mockClear().mockResolvedValue([]);
  native.contacts.Contact.getAll.mockClear();
  contacts = await import("./dozo-phone-contacts");
});

describe("the contacts query", () => {
  it.each(["", "   ", "a", " a ", "*", "%%", "..", "_?", "* . %", "a*", "a.%"])(
    "refuses %j",
    (query) => {
      expect(contacts.contactsQuery(query)).toBeNull();
    },
  );

  it("keeps a query with two letters or digits, trimmed and in one form", () => {
    expect(contacts.contactsQuery("  Ad ")).toBe("Ad");
    expect(contacts.contactsQuery("42")).toBe("42");
    expect(contacts.contactsQuery("Ａｄａ")).toBe("Ada");
    expect(contacts.contactsQuery("Şü")).toBe("Şü");
  });

  it("matches the query as one line, as the server sends it", () => {
    expect(contacts.contactsQuery("Ada\n\n\tLovelace\u202E\u200B")).toBe("Ada Lovelace");
    expect(contacts.contactsQuery(`\n${"\n".repeat(200)}\u0007`)).toBeNull();
  });
});

describe("the contacts' value", () => {
  it("matches the name only, ignoring case and accents, wherever it falls in the name", () => {
    const value = contacts.contactsValue(
      [
        person("Adam Smith"),
        person("Zoë Lada"),
        person("ADALET Yılmaz"),
        person("Ádám Kovács"),
        person("Bob", { company: "Ada Corp", note: "ada", nickname: "Ada" }),
        person(null),
      ],
      phone,
    );
    expect(value.contacts.map((entry) => entry.name)).toEqual([
      "ADALET Yılmaz",
      "Ádám Kovács",
      "Adam Smith",
      "Zoë Lada",
    ]);
    expect(value.truncated).toBe(false);
    expect(
      contacts.contactsValue([person("Zoë Lada")], { ...phone, query: "ZOE" }).contacts,
    ).toHaveLength(1);
  });

  it("sends the name and the asked kind of value only, never the rest of the record", () => {
    const record = person("Ada Lovelace", {
      phones: [{ number: " +1 555 0100 ", label: "home" }],
      emails: [{ address: "ada@example.test" }],
      addresses: [{ street: "Main St 1" }],
      birthday: { day: 10, month: 12 },
      note: "met at the conference",
      company: "Analytical Engines",
      image: "file:///photo.jpg",
      relations: [{ name: "Byron" }],
    });
    expect(contacts.contactsValue([record], phone)).toEqual({
      contacts: [{ name: "Ada Lovelace", values: ["+1 555 0100"] }],
      truncated: false,
    });
    expect(contacts.contactsValue([record], { ...phone, field: "email" })).toEqual({
      contacts: [{ name: "Ada Lovelace", values: ["ada@example.test"] }],
      truncated: false,
    });
  });

  it("keeps at most three values of 100 characters, skipping empty ones", () => {
    const value = contacts.contactsValue(
      [
        person("Ada", {
          phones: [
            { number: "" },
            { number: "   " },
            {},
            { number: "1".repeat(150) },
            { number: "2" },
            { number: "3" },
            { number: "4" },
          ],
        }),
        person("Ada Without", { phones: undefined }),
      ],
      phone,
    );
    expect(value.contacts).toEqual([{ name: "Ada", values: ["1".repeat(100), "2", "3"] }]);
  });

  it("keeps at most ten contacts, sorted by name, and says when there were more", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      person(`Ada ${String(12 - index).padStart(2, "0")}`),
    );
    const value = contacts.contactsValue(many, { ...phone, limit: 50 });
    expect(value.contacts).toHaveLength(10);
    expect(value.contacts[0]!.name).toBe("Ada 01");
    expect(value.contacts[9]!.name).toBe("Ada 10");
    expect(value.truncated).toBe(true);
    const few = contacts.contactsValue(many, { ...phone, limit: 2 });
    expect(few.contacts.map((entry) => entry.name)).toEqual(["Ada 01", "Ada 02"]);
    expect(contacts.contactsValue(many, { ...phone, limit: Number.NaN }).contacts).toHaveLength(10);
  });

  it("sends only contacts with a value of the asked kind, and counts only those", () => {
    const without = Array.from({ length: 10 }, (_, index) =>
      person(`Ada ${String(index).padStart(2, "0")}`, { emails: [] }),
    );
    const value = contacts.contactsValue(
      [...without, person("Ada Zed", { emails: [{ address: "zed@example.test" }] })],
      { ...phone, field: "email" },
    );
    expect(value).toEqual({
      contacts: [{ name: "Ada Zed", values: ["zed@example.test"] }],
      truncated: false,
    });
  });

  it("takes links out of the name, cuts it to 100 characters, and finds nothing by a link", () => {
    const value = contacts.contactsValue(
      [
        person("Ada https://x.example/profile?id=1"),
        person("https://only.example"),
        person(`Ada ${"n".repeat(300)}`),
      ],
      phone,
    );
    expect(value.contacts.map((entry) => entry.name)).toEqual(["Ada", `Ada ${"n".repeat(96)}`]);
    expect(
      contacts.contactsValue([person("Ada https://x.example/profile")], {
        ...phone,
        query: "example",
      }).contacts,
    ).toEqual([]);
  });

  it("refuses a bad query", () => {
    expect(() => contacts.contactsValue([person("Ada")], { ...phone, query: "%" })).toThrow(
      expect.objectContaining({ code: "contacts-query" }),
    );
  });
});

describe("searching the phone's contacts", () => {
  it("asks the system for the name and the asked kind only", async () => {
    native.contacts.Contact.getAllDetails.mockResolvedValueOnce([person("Ada Lovelace")]);
    const value = await contacts.searchContacts(phone);
    expect(native.contacts.Contact.getAllDetails).toHaveBeenCalledWith(["fullName", "phones"]);
    expect(value.contacts).toEqual([{ name: "Ada Lovelace", values: ["+1 555 0100"] }]);
    await contacts.searchContacts({ ...phone, field: "email" });
    expect(native.contacts.Contact.getAllDetails).toHaveBeenLastCalledWith(["fullName", "emails"]);
    expect(native.contacts.Contact.getAll).not.toHaveBeenCalled();
  });

  it("refuses a bad query before reading anything", async () => {
    await expect(contacts.searchContacts({ ...phone, query: " * " })).rejects.toMatchObject({
      code: "contacts-query",
    });
    expect(native.contacts.getPermissionsAsync).not.toHaveBeenCalled();
    expect(native.contacts.Contact.getAllDetails).not.toHaveBeenCalled();
  });

  it("refuses without the system's permission", async () => {
    native.contacts.getPermissionsAsync.mockResolvedValueOnce({ granted: false });
    await expect(contacts.searchContacts(phone)).rejects.toMatchObject({
      code: "contacts-permission",
    });
    expect(native.contacts.Contact.getAllDetails).not.toHaveBeenCalled();
  });

  it.each([
    ["a build without the module", () => (native.module = null)],
    ["a module that fails to load", withoutNativeModule],
    [
      "a failed read",
      () => native.contacts.Contact.getAllDetails.mockRejectedValueOnce(new Error("boom")),
    ],
  ])("is unavailable in %s", async (_name, arrange) => {
    await arrange();
    await expect(contacts.searchContacts(phone)).rejects.toMatchObject({
      code: "contacts-unavailable",
    });
  });

  it("loads the module once a failed load is over", async () => {
    await withoutNativeModule();
    expect(await contacts.contactsPermission()).toBe("unavailable");
    vi.doMock("expo-contacts", () => native.contacts);
    expect(await contacts.contactsPermission()).toBe("granted");
  });
});

describe("the contacts permission", () => {
  it("is unavailable in a build without the module, and never asked there", async () => {
    native.module = null;
    expect(contacts.contactsAvailable()).toBe(false);
    expect(await contacts.contactsPermission()).toBe("unavailable");
    expect(await contacts.requestContactsPermission()).toBe("unavailable");
    expect(native.contacts.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("asks the system, and reads its answer", async () => {
    expect(contacts.contactsAvailable()).toBe(true);
    expect(await contacts.requestContactsPermission()).toBe("granted");
    native.contacts.requestPermissionsAsync.mockResolvedValueOnce({ granted: false });
    expect(await contacts.requestContactsPermission()).toBe("denied");
    native.contacts.getPermissionsAsync.mockResolvedValueOnce({ granted: false });
    expect(await contacts.contactsPermission()).toBe("denied");
  });

  it("reads a failing permission call as unavailable", async () => {
    native.contacts.getPermissionsAsync.mockRejectedValueOnce(new Error("boom"));
    expect(await contacts.contactsPermission()).toBe("unavailable");
    native.contacts.requestPermissionsAsync.mockRejectedValueOnce(new Error("boom"));
    expect(await contacts.requestContactsPermission()).toBe("unavailable");
  });

  it("is not offered on the web", () => {
    native.platform.OS = "web";
    expect(contacts.contactsAvailable()).toBe(false);
  });
});
