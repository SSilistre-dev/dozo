/** @jsxRuntime automatic */
import { Column, Hr, Img, Link, Row, Section, Text } from "react-email";

// The Dozo look of every account email. Anchored rules in dozo/brand/brand.json point upstream's
// email.tsx at these: its colours, font, header and footer. Mail clients cannot read the app's CSS
// variables or alpha borders, so the palette is the Dozo theme (dozo/theme/theme.json) as solid
// hex values, with each border flattened onto its card.

/** Light palette, under the token names email.tsx reads. */
export const lightTokens = {
  muted: "#F5F5F3",
  background: "#F5F5F3",
  dialog: "#FFFFFF",
  foreground: "#1A1A1A",
  mutedForeground: "#6B6B6B",
  border: "#EBEBEB",
  primary: "#1A1A1A",
  primaryForeground: "#F5F5F3",
};

/** Dark palette, applied by clients that honour prefers-color-scheme. */
export const webDarkTokens = {
  muted: "#141414",
  background: "#141414",
  dialog: "#1F1F1F",
  foreground: "#EDEDED",
  mutedForeground: "#A3A3A3",
  border: "#333333",
  primary: "#EDEDED",
  primaryForeground: "#141414",
};

export const EMAIL_FONT =
  '-apple-system, "SF Pro Text", Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const SITE = "https://dozo-site.ssilistre.dev";
const CONTACT = "info@ssilistre.dev";
const OPERATOR = "SSilistre.dev";

type FooterCopy = { privacy: string; terms: string; path: string };
const ENGLISH: FooterCopy = { privacy: "Privacy", terms: "Terms", path: "" };
// The policies exist in English and Turkish only (dozo/landing); other languages read English.
const FOOTER: Readonly<Record<string, FooterCopy>> = {
  en: ENGLISH,
  tr: { privacy: "Gizlilik", terms: "Koşullar", path: "/tr" },
};

/**
 * Where the logo mark is loaded from: the server's own public web origin, which serves the app
 * icon. Nothing when the origin is not a public https address (a local or unset origin), so a mail
 * never asks a client to load an image from a host other than the one that sent it.
 */
export function markUrl(origin = process.env.WEB_ORIGIN): string | null {
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  return url.protocol === "https:" && publicDnsName(url.hostname)
    ? `${url.origin}/icon-192.png`
    : null;
}

// Names that only resolve inside a network or on one machine.
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa"];

/**
 * A DNS name a mail client elsewhere can reach: no IP literal (the URL parser has already turned
 * every IPv4 spelling into dotted decimal and wrapped IPv6 in brackets), at least two labels, an
 * alphabetic top-level label, and no private-use suffix.
 */
function publicDnsName(hostname: string): boolean {
  const labels = hostname.split(".");
  const top = labels.at(-1) ?? "";
  if (hostname.startsWith("[") || labels.length < 2 || !/^[a-z]{2,}$/.test(top)) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/** The mark and the wordmark. Without a public origin the wordmark stands alone. */
export function DozoHeader({ mark = markUrl() }: { mark?: string | null }) {
  const wordmark = (
    <Text style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.5px" }}>
      dozo
    </Text>
  );
  return (
    <Section style={{ margin: "0 0 24px" }}>
      {mark ? (
        <Row>
          <Column style={{ width: "40px", verticalAlign: "middle" }}>
            <Img
              src={mark}
              alt=""
              width="30"
              height="30"
              style={{ display: "block", borderRadius: "8px" }}
            />
          </Column>
          <Column style={{ verticalAlign: "middle" }}>{wordmark}</Column>
        </Row>
      ) : (
        wordmark
      )}
    </Section>
  );
}

/** Unsubscribe (when the mail has one), the policies, and who runs the service. */
export function DozoFooter({
  locale,
  unsubscribe,
}: {
  locale: string;
  unsubscribe?: { href: string; label: string };
}) {
  const say = FOOTER[locale] ?? ENGLISH;
  const link = { color: lightTokens.mutedForeground, textDecoration: "underline" };
  const line = { color: lightTokens.mutedForeground, fontSize: "12px", lineHeight: "18px" };
  return (
    <>
      {/* The card's own dark rule covers its border, not this one. */}
      <style>{`@media (prefers-color-scheme: dark) { .dozo-rule { border-color: ${webDarkTokens.border} !important; } }`}</style>
      <Hr className="dozo-rule" style={{ borderColor: lightTokens.border, marginTop: "28px" }} />
      <Text className="email-muted" style={{ ...line, margin: "12px 0 0" }}>
        {unsubscribe ? (
          <>
            <Link href={unsubscribe.href} style={link}>
              {unsubscribe.label}
            </Link>
            {" · "}
          </>
        ) : null}
        <Link href={`${SITE}${say.path}/privacy/`} style={link}>
          {say.privacy}
        </Link>
        {" · "}
        <Link href={`${SITE}${say.path}/terms/`} style={link}>
          {say.terms}
        </Link>
      </Text>
      <Text className="email-muted" style={{ ...line, margin: "4px 0 0" }}>
        {`Dozo · ${OPERATOR} · `}
        <Link href={`mailto:${CONTACT}`} style={link}>
          {CONTACT}
        </Link>
      </Text>
    </>
  );
}
