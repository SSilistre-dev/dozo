import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme;

const reply = [
  "The area of a circle is $A = \\pi r^2$, so doubling $r$ makes it four times larger.",
  "",
  "$$",
  "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
  "$$",
  "",
  "The plan costs $5 a month or $50 a year.",
  "",
  "| $n$ | $n^2$ | $\\sqrt{n}$ |",
  "| --- | --- | --- |",
  "| 2 | 4 | $\\approx 1.41$ |",
  "| 3 | 9 | $\\approx 1.73$ |",
].join("\n");

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="max-w-2xl" data-testid="reply">
        <ChatMarkdown streaming={params.has("stream")}>
          {params.has("stream") ? "Almost there:\n\n$$\n\\frac{a}{" : reply}
        </ChatMarkdown>
      </div>
    </main>,
  );
}
