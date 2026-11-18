import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerNetworkCreateOptions } from "./computer-spec.js";
import {
  computerNetworkRange,
  freeSubnet,
  usedBlocks,
  withComputerSubnets,
  withSubnet,
} from "./dozo-computer-subnet.js";
import { COMPUTER_MEMORY_BUDGET_FULL } from "./dozo-memory-budget.js";

const RANGE_ENV = "RAKAZO_COMPUTER_NETWORK_RANGE";

type Created = { Name?: string; IPAM?: { Config?: Array<{ Subnet?: string }> } };

/** A Docker with only networks: it lists what it holds and refuses a name or a subnet twice. */
function fakeDocker(initial: Array<{ name: string; subnets: string[] }> = []) {
  const networks = new Map(initial.map((item) => [item.name, item.subnets]));
  const listNetworks = vi.fn(async () =>
    [...networks].map(([Name, subnets]) => ({
      Name,
      IPAM: { Config: subnets.map((Subnet) => ({ Subnet })) },
    })),
  );
  const createNetwork = vi.fn(async (options: Created) => {
    const name = options.Name ?? "";
    if (networks.has(name)) throw new Error(`network with name ${name} already exists`);
    const subnets = (options.IPAM?.Config ?? []).flatMap((entry) => entry.Subnet ?? []);
    const held = [...networks.values()].flat();
    if (subnets.some((subnet) => held.includes(subnet))) {
      throw new Error("invalid pool request: Pool overlaps with other one on this address space");
    }
    networks.set(name, subnets);
    return { id: name };
  });
  // biome-ignore lint/suspicious/noExplicitAny: the double has only the two calls the picker makes
  return { networks, listNetworks, createNetwork, docker: { listNetworks, createNetwork } as any };
}

const range = (cidr: string) => {
  const parsed = computerNetworkRange(cidr);
  if (!parsed) throw new Error("no range");
  return parsed;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("computerNetworkRange", () => {
  it("is unset when the operator set none", () => {
    expect(computerNetworkRange(undefined)).toBeUndefined();
    expect(computerNetworkRange("  ")).toBeUndefined();
  });

  it.each([
    "10.214.0.0",
    "10.214.0.0/29",
    "10.214.0.1/16",
    "10.256.0.0/16",
    "10.214.0.0/33",
    "fd00::/64",
    "ten",
  ])("refuses the malformed range %s, naming the variable", (raw) => {
    expect(() => computerNetworkRange(raw)).toThrow(RANGE_ENV);
  });

  it("stops the supervisor at start on a malformed range", () => {
    vi.stubEnv(RANGE_ENV, "10.214.0.0/40");
    expect(() => withComputerSubnets(fakeDocker().docker)).toThrow(RANGE_ENV);
  });
});

describe("freeSubnet", () => {
  it("takes the first /28 of an empty range", () => {
    expect(freeSubnet(range("10.214.0.0/16"), [])).toBe("10.214.0.0/28");
  });

  it("skips subnets in use, whatever their size", () => {
    const used = usedBlocks([
      { Name: "a", IPAM: { Config: [{ Subnet: "10.214.0.0/28" }, { Subnet: "fd00::/64" }] } },
      { Name: "b", IPAM: { Config: [{ Subnet: "10.214.0.16/28" }] } },
      // A wider network of another project that covers the next two.
      { Name: "c", IPAM: { Config: [{ Subnet: "10.214.0.32/27" }] } },
      { Name: "d" },
    ]);
    expect(freeSubnet(range("10.214.0.0/16"), used)).toBe("10.214.0.64/28");
  });

  it("skips the part of the range a wider network covers", () => {
    const used = usedBlocks([{ Name: "stack", IPAM: { Config: [{ Subnet: "10.0.0.0/8" }] } }]);
    expect(freeSubnet(range("10.214.0.0/16"), used)).toBeUndefined();
  });

  it("has none left when every subnet is taken", () => {
    const used = usedBlocks([
      { Name: "a", IPAM: { Config: [{ Subnet: "10.214.0.0/28" }] } },
      { Name: "b", IPAM: { Config: [{ Subnet: "10.214.0.16/28" }] } },
    ]);
    expect(freeSubnet(range("10.214.0.0/27"), used)).toBeUndefined();
  });

  it("reaches the last subnet of the range", () => {
    const used = usedBlocks([{ Name: "a", IPAM: { Config: [{ Subnet: "10.214.255.0/25" }] } }]);
    expect(freeSubnet(range("10.214.255.0/24"), used)).toBe("10.214.255.128/28");
  });
});

describe("create options", () => {
  it("carry the subnet and keep everything upstream sets", () => {
    const upstream = computerNetworkCreateOptions("bot-1", "owner-1", "restricted");
    const options = withSubnet(upstream, "10.214.0.16/28");
    expect(options).toEqual({
      ...upstream,
      IPAM: { Driver: "default", Config: [{ Subnet: "10.214.0.16/28", Gateway: "10.214.0.17" }] },
    });
    expect(options.Options?.["com.docker.network.bridge.name"]).toBeTruthy();
  });

  it("leave IPv6 automatic: no IPv6 entry beside the IPv4 subnet", () => {
    const options = withSubnet(computerNetworkCreateOptions("bot-1", "owner-1"), "10.214.0.0/28");
    expect(options.EnableIPv6).toBe(true);
    expect(options.IPAM.Config).toEqual([{ Subnet: "10.214.0.0/28", Gateway: "10.214.0.1" }]);
  });
});

describe("the gateway", () => {
  it("is the first host address of the subnet, named so every daemon reports it", () => {
    expect(withSubnet({}, "10.214.255.240/28").IPAM.Config[0]?.Gateway).toBe("10.214.255.241");
    expect(withSubnet({}, "10.214.1.0/28").IPAM.Config[0]?.Gateway).toBe("10.214.1.1");
  });

  it("is on every network the wrapped client creates", async () => {
    vi.stubEnv(RANGE_ENV, "10.214.0.0/16");
    const fake = fakeDocker([{ name: "other", subnets: ["10.214.0.0/28"] }]);
    await withComputerSubnets(fake.docker).createNetwork({ Name: "one" });
    expect(fake.createNetwork).toHaveBeenCalledWith({
      Name: "one",
      IPAM: { Driver: "default", Config: [{ Subnet: "10.214.0.16/28", Gateway: "10.214.0.17" }] },
    });
  });

  it("refuses a subnet it cannot read", () => {
    expect(() => withSubnet({}, "fd00::/64")).toThrow("not an IPv4 subnet");
  });
});

describe("withComputerSubnets", () => {
  it("leaves the client untouched with no range set", async () => {
    vi.stubEnv(RANGE_ENV, "");
    const fake = fakeDocker();
    const docker = withComputerSubnets(fake.docker);
    await docker.createNetwork({ Name: "one" });
    expect(fake.listNetworks).not.toHaveBeenCalled();
    expect(fake.createNetwork).toHaveBeenCalledWith({ Name: "one" });
  });

  it("gives each network the next free subnet of the range", async () => {
    vi.stubEnv(RANGE_ENV, "10.214.0.0/16");
    const fake = fakeDocker([{ name: "other", subnets: ["10.214.0.0/28", "192.168.0.0/20"] }]);
    const docker = withComputerSubnets(fake.docker);
    await docker.createNetwork({ Name: "one", EnableIPv6: true });
    await docker.createNetwork({ Name: "two" });
    expect(fake.networks.get("one")).toEqual(["10.214.0.16/28"]);
    expect(fake.networks.get("two")).toEqual(["10.214.0.32/28"]);
  });

  it("gives two creations at once different subnets", async () => {
    vi.stubEnv(RANGE_ENV, "10.214.0.0/16");
    const fake = fakeDocker();
    // The first list is held open, so the second creation starts while the first has picked nothing.
    const held = deferred<void>();
    const list = fake.listNetworks.getMockImplementation();
    fake.listNetworks.mockImplementationOnce(async () => {
      await held.promise;
      return list ? list() : [];
    });
    const docker = withComputerSubnets(fake.docker);
    const both = Promise.all([
      docker.createNetwork({ Name: "one" }),
      docker.createNetwork({ Name: "two" }),
    ]);
    await vi.waitFor(() => expect(fake.listNetworks).toHaveBeenCalledTimes(1));
    expect(fake.createNetwork).not.toHaveBeenCalled();
    held.resolve();
    await both;
    expect(fake.networks.get("one")).toEqual(["10.214.0.0/28"]);
    expect(fake.networks.get("two")).toEqual(["10.214.0.16/28"]);
  });

  it("takes the next subnet when Docker says the chosen one overlaps", async () => {
    vi.stubEnv(RANGE_ENV, "10.214.0.0/16");
    const fake = fakeDocker();
    const docker = withComputerSubnets(fake.docker);
    // Another process took the first subnet after the list was read.
    fake.listNetworks.mockImplementationOnce(async () => {
      fake.networks.set("outside", ["10.214.0.0/28"]);
      return [];
    });
    await docker.createNetwork({ Name: "one" });
    expect(fake.networks.get("one")).toEqual(["10.214.0.16/28"]);
    expect(fake.createNetwork).toHaveBeenCalledTimes(2);
  });

  it("gives up with Docker's error after a bounded number of overlaps", async () => {
    vi.stubEnv(RANGE_ENV, "10.214.0.0/16");
    const fake = fakeDocker();
    fake.createNetwork.mockRejectedValue(new Error("Pool overlaps with other one"));
    const docker = withComputerSubnets(fake.docker);
    await expect(docker.createNetwork({ Name: "one" })).rejects.toThrow("Pool overlaps");
    expect(fake.createNetwork).toHaveBeenCalledTimes(8);
    const tried = fake.createNetwork.mock.calls.map(
      ([options]) => options.IPAM?.Config?.[0]?.Subnet,
    );
    expect(new Set(tried).size).toBe(8);
  });

  it("refuses a start as a full host when the range has no subnet left", async () => {
    vi.stubEnv(RANGE_ENV, "10.214.0.0/28");
    const fake = fakeDocker([{ name: "taken", subnets: ["10.214.0.0/28"] }]);
    const docker = withComputerSubnets(fake.docker);
    await expect(docker.createNetwork({ Name: "one" })).rejects.toThrow(
      COMPUTER_MEMORY_BUDGET_FULL,
    );
    expect(fake.createNetwork).not.toHaveBeenCalled();
  });

  it("still answers 'already exists' for a network it holds, even with the range full", async () => {
    vi.stubEnv(RANGE_ENV, "10.214.0.0/28");
    const fake = fakeDocker([{ name: "one", subnets: ["10.214.0.0/28"] }]);
    const docker = withComputerSubnets(fake.docker);
    await expect(docker.createNetwork({ Name: "one" })).rejects.toThrow(/already exists/);
  });

  it("passes other Docker errors through and lets the next creation run", async () => {
    vi.stubEnv(RANGE_ENV, "10.214.0.0/16");
    const fake = fakeDocker();
    fake.createNetwork.mockRejectedValueOnce(new Error("ip6tables is missing"));
    const docker = withComputerSubnets(fake.docker);
    await expect(docker.createNetwork({ Name: "one", EnableIPv6: true })).rejects.toThrow(
      "ip6tables",
    );
    // The IPv6 fallback's second create gets the same subnet, which was never taken.
    await docker.createNetwork({ Name: "one" });
    expect(fake.networks.get("one")).toEqual(["10.214.0.0/28"]);
  });
});
