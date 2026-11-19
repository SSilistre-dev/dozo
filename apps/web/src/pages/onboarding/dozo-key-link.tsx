import { dozoModelKeyPage } from "@rakazo/core";
import { ArrowUpRight } from "lucide-react";

/** Under the API key field: the provider's page where keys are made, named by its address. */
export function DozoKeyLink({ provider }: { provider: string }) {
  const page = dozoModelKeyPage(provider);
  if (!page) return null;
  return (
    <a
      href={page}
      target="_blank"
      rel="noreferrer"
      className="mt-2 inline-flex items-center gap-1 text-body-sm font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {new URL(page).hostname}
      <ArrowUpRight size={14} strokeWidth={1.8} aria-hidden="true" />
    </a>
  );
}
