/**
 * The pairing links the app acts on, the offer after `#` (`dozo/relay/PROTOCOL.md`, Pairing link).
 * The computer writes the fork's own scheme; the upstream scheme is still read because desktop
 * 0.3.0 writes it.
 */
const PAIRING_LINKS = [
  "dozo://pair#",
  "dozo://pair/#",
  "rakazo://dozo-pair#",
  "rakazo://dozo-pair/#",
];

/** The offer in a pairing link, or undefined for any other link. */
export function linkedOffer(link: string | null) {
  const prefix = link ? PAIRING_LINKS.find((start) => link.startsWith(start)) : undefined;
  const offer = prefix ? link?.slice(prefix.length) : undefined;
  return offer && /^[A-Za-z0-9_-]+$/.test(offer) ? offer : undefined;
}

/**
 * The route a system link opens: `dozo://pair` opens the pairing screen, which reads the offer
 * from the link itself. Every other link is left as it came.
 */
export function pairingRoute(path: string) {
  return /^dozo:\/\/pair\/?(?:#|$)/.test(path) ? "/dozo-pair" : path;
}
