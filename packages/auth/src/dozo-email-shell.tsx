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

const SITE = "https://dozo.bot";
const CONTACT = "info@ssilistre.dev";
const OPERATOR = "SSilistre.dev";

type FooterCopy = { privacy: string; terms: string; path: string };
const ENGLISH: FooterCopy = { privacy: "Privacy", terms: "Terms", path: "" };
// The policies exist in English and Turkish only (dozo/landing); other languages read English.
const FOOTER: Readonly<Record<string, FooterCopy>> = {
  en: ENGLISH,
  tr: { privacy: "Gizlilik", terms: "Koşullar", path: "/tr" },
};

/** The name the header's image is referenced by (`cid:`), inside the message. */
const MARK_ID = "dozo-mark";

/**
 * The logo mark, sent inside every mail as an inline image instead of being loaded from a server:
 * clients that block remote images (or cannot reach the host) show it all the same, and a mail
 * never calls out. 60 px square (the 30 px header at 2x), corners already rounded so clients that
 * drop CSS radius still show the app icon's shape. Made from `dozo/brand/assets/web/icon-192.png`.
 */
export const DOZO_MARK = {
  contentId: MARK_ID,
  filename: "dozo.png",
  contentType: "image/png",
  content:
    "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",
};

/** The mark and the wordmark. */
export function DozoHeader() {
  return (
    <Section style={{ margin: "0 0 24px" }}>
      <Row>
        <Column style={{ width: "40px", verticalAlign: "middle" }}>
          <Img
            src={`cid:${MARK_ID}`}
            alt=""
            width="30"
            height="30"
            style={{ display: "block", borderRadius: "8px" }}
          />
        </Column>
        <Column style={{ verticalAlign: "middle" }}>
          <Text style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.5px" }}>
            dozo
          </Text>
        </Column>
      </Row>
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
