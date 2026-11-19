/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { translate } from "@rakazo/core";
import { Text } from "react-email";
import { Button, CATALOGS, greeting, message } from "./email.js";

// Billing's own transactional mails: a failed payment, a plan about to end and a cancellation. They
// are not marketing, so they carry no unsubscribe link and a marketing opt-out does not stop them.
// They are written in English and Turkish only; any other language reads English.

const TURKISH: Readonly<Record<string, string>> = {
  "Your Dozo payment didn't go through": "Dozo ödemeniz alınamadı",
  "Your last payment for {plan} didn't go through. Update your payment method to keep your plan.":
    "{plan} için son ödemeniz alınamadı. Planınızı korumak için ödeme yönteminizi güncelleyin.",
  "Your {plan} plan ends on {date}": "{plan} planınız {date} tarihinde bitiyor",
  "On {date} your account moves to {next}.": "{date} tarihinde hesabınız {next} planına geçecek.",
  "Your Dozo subscription is canceled": "Dozo aboneliğiniz iptal edildi",
  "You keep {plan} until {date}.": "{date} tarihine kadar {plan} planınız devam eder.",
  "Manage billing": "Faturalandırmayı yönet",
};

/** The language a billing mail is written in: Turkish for a Turkish reader, else English. */
export function billingEmailLocale(locale: string): "en" | "tr" {
  return locale === "tr" ? "tr" : "en";
}

function texts(locale: "en" | "tr") {
  // The greeting and the footer come from the shared catalog, the rest from this file's.
  const catalog = locale === "tr" ? { ...CATALOGS.tr, ...TURKISH } : undefined;
  return (text: string, values?: Record<string, string | number>) =>
    translate(catalog, text, values);
}

function day(at: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(at);
}

type Reader = { email: string; name: string; locale: string };

/** The subscription is past due: what happened, and the one place to fix it. */
export function paymentFailedEmail(
  reader: Reader,
  plan: string,
  billingUrl: string,
): Promise<TransactionalEmail> {
  const locale = billingEmailLocale(reader.locale);
  const say = texts(locale);
  return message(
    reader.email,
    locale,
    say("Your Dozo payment didn't go through"),
    <>
      <Text>{greeting(say, reader.name)}</Text>
      <Text>
        {say(
          "Your last payment for {plan} didn't go through. Update your payment method to keep your plan.",
          { plan },
        )}
      </Text>
      <Button href={billingUrl}>{say("Manage billing")}</Button>
    </>,
  );
}

/** The plan in force ends soon and nothing renews it: the day, and the plan that follows. */
export function planEndingEmail(
  reader: Reader,
  plan: { name: string; endsAt: Date; next: string },
  billingUrl: string,
): Promise<TransactionalEmail> {
  const locale = billingEmailLocale(reader.locale);
  const say = texts(locale);
  const date = day(plan.endsAt, locale);
  return message(
    reader.email,
    locale,
    say("Your {plan} plan ends on {date}", { plan: plan.name, date }),
    <>
      <Text>{greeting(say, reader.name)}</Text>
      <Text>{say("On {date} your account moves to {next}.", { date, next: plan.next })}</Text>
      <Button href={billingUrl}>{say("Manage billing")}</Button>
    </>,
  );
}

/** The subscription was set to end with its period: until when the plan stays. */
export function cancellationEmail(
  reader: Reader,
  plan: { name: string; endsAt: Date },
  billingUrl: string,
): Promise<TransactionalEmail> {
  const locale = billingEmailLocale(reader.locale);
  const say = texts(locale);
  return message(
    reader.email,
    locale,
    say("Your Dozo subscription is canceled"),
    <>
      <Text>{greeting(say, reader.name)}</Text>
      <Text>
        {say("You keep {plan} until {date}.", { plan: plan.name, date: day(plan.endsAt, locale) })}
      </Text>
      <Button href={billingUrl}>{say("Manage billing")}</Button>
    </>,
  );
}
