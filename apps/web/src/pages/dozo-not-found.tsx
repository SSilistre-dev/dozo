import { NotFoundPage as UpstreamNotFoundPage } from "./NotFound";

/**
 * Upstream's 404 page with the Dozo dragon of the landing page faint behind it. App.tsx loads this
 * page on demand (an anchored rule points its lazy import here), so the drawing never reaches the
 * startup bundle. The figure adds no words and does not move.
 */
export function NotFoundPage() {
  return (
    <div className="relative isolate h-full bg-background [&>[data-rakazo-surface=not-found]]:bg-transparent">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <DozoDragon className="absolute top-1/2 left-1/2 w-[max(36rem,min(62rem,110%))] -translate-x-1/2 -translate-y-1/2 text-foreground opacity-10" />
      </div>
      <UpstreamNotFoundPage />
    </div>
  );
}

/**
 * The scaled dragon of `dozo/landing/index.html` (`.scales`): the mark's head on a long body. The
 * body and head take the text colour and the band the brand's seal red, so both themes draw it
 * from their tokens; the cut-outs take the page background.
 */
function DozoDragon({ className }: { className?: string }) {
  return (
    <svg data-dozo-dragon="" viewBox="0 -70 990 210" className={className}>
      <defs>
        <pattern id="dozo-dragon-scales" width="24" height="12" patternUnits="userSpaceOnUse">
          <g className="fill-background" stroke="currentColor" strokeWidth="1">
            <path d="M0 12a12 12 0 0 0 24 0z" />
            <path d="M-12 6a12 12 0 0 0 24 0zM12 6a12 12 0 0 0 24 0z" />
            <path d="M0 0a12 12 0 0 0 24 0z" />
            <path d="M-12 -6a12 12 0 0 0 24 0zM12 -6a12 12 0 0 0 24 0z" />
          </g>
        </pattern>
        <linearGradient id="dozo-dragon-neck" gradientUnits="userSpaceOnUse" x1="600" x2="880">
          <stop offset="0" stopColor="currentColor" stopOpacity="0" />
          <stop offset=".6" stopColor="currentColor" stopOpacity=".35" />
          <stop offset="1" stopColor="currentColor" />
        </linearGradient>
        <path id="dozo-dragon-body" d={BODY} />
      </defs>
      <path fill="currentColor" transform="translate(20 3.6) rotate(11.7)" d={TAIL} />
      <use
        href="#dozo-dragon-body"
        fill="url(#dozo-dragon-scales)"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <use href="#dozo-dragon-body" fill="url(#dozo-dragon-neck)" />
      <path
        fill="currentColor"
        className="stroke-background"
        strokeWidth="1.5"
        strokeLinejoin="round"
        d={SPINE}
      />
      <g transform="translate(873.6 -34.4) scale(1.2)">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          d="M27 12q-6 -12 -21 -10M36 10q-3 -10 -15 -14"
        />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          d="M54 30c12 2 20 -5 23 -15M52 36c10 8 22 6 28 -2"
        />
        <path className="fill-background" d={VISOR} />
        <path fill="currentColor" fillRule="evenodd" d={HEAD} />
        <circle cx="25.95" cy="32.74" r="3.2" fill="currentColor" />
        <circle cx="38.05" cy="31.26" r="3.2" fill="currentColor" />
        <g style={{ fill: "var(--dozo-seal)" }}>
          {BAND.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      </g>
    </svg>
  );
}

const BODY =
  "M20.1 3.2L30.6 4.5L41.2 7.5L51.9 11.7L62.5 16.8L73.1 22.5L83.7 28.5L94.1 34.5L104.3 40L114.3 44.9L124 48.9L133.3 51.8L142.3 53.5L150.8 54L159.1 53.3L167.3 51.4L175.6 48.5L184 44.4L192.7 39.4L201.7 33.4L210.9 26.8L220.4 19.7L230.2 12.4L240.3 5.2L250.9 -1.6L261.9 -7.8L273.5 -13L285.7 -17L298.5 -19.4L311.6 -20L324.6 -18.8L337.4 -15.9L349.8 -11.7L361.4 -5.9L372.5 0.5L383.2 7.3L393.4 14.1L403.2 20.6L412.5 26.5L421.4 31.7L429.8 35.9L437.6 39L444.9 40.9L451.7 41.9L458.3 41.9L465.1 40.9L472.4 39L480.2 35.9L488.6 31.7L497.5 26.5L506.8 20.6L516.6 14.1L526.8 7.3L537.5 0.5L548.6 -5.9L560.2 -11.7L572.4 -16.5L585.1 -19.9L598.3 -21.8L611.7 -21.8L624.9 -19.9L637.6 -16.5L649.8 -11.7L661.4 -5.9L672.5 0.5L683.2 7.3L693.4 14.1L703.2 20.6L712.5 26.5L721.4 31.7L729.8 35.9L737.6 39L744.9 40.9L751.7 41.9L758.3 41.9L765.1 40.9L772.4 39L780.2 35.9L788.6 31.7L797.5 26.5L806.8 20.6L816.6 14.1L826.8 7.3L838 1.4L849.5 -4.1L861.4 -8.9L873.7 -12.6L886.2 -14.9L898.8 -15.6L911.2 -14.6L908.8 18.9L901.2 20L893.8 22L886.3 25.1L878.6 29.3L870.5 34.5L862 40.6L853.2 47.4L843.4 53.9L833.2 60.7L822.5 67.5L811.4 73.9L799.8 79.7L787.6 84.5L774.9 87.9L761.7 89.8L748.3 89.8L735.1 87.9L722.4 84.5L710.2 79.7L698.6 73.9L687.5 67.5L676.8 60.7L666.6 53.9L656.8 47.4L647.5 41.5L638.6 36.3L630.2 32.1L622.4 29L615.1 27.1L608.3 26.1L601.7 26.1L594.9 27.1L587.6 29L579.8 32.1L571.4 36.3L562.5 41.5L553.2 47.4L543.4 53.9L533.2 60.7L522.5 67.5L511.4 73.9L499.8 79.7L487.6 84.5L474.9 87.9L461.7 89.8L448.3 89.8L435.1 87.9L422.4 84.5L410.2 79.7L398.6 73.9L387.5 67.5L376.8 60.7L366.6 53.9L356.8 47.4L347.5 41.5L338.6 36.3L330.2 32.1L322.6 28.5L315.4 25.9L308.4 24.3L301.5 23.7L294.3 24.1L286.5 25.6L278.1 28.3L269.1 32L259.7 36.8L249.8 42.3L239.6 48.3L229.1 54.5L218.3 60.6L207.3 66.3L196 71.1L184.4 74.9L172.7 77.4L160.9 78.4L149.2 77.7L137.7 75.4L126.7 71.6L116 66.6L105.7 60.7L95.7 54L85.9 46.8L76.3 39.5L66.9 32.2L57.5 25.1L48.1 18.7L38.8 12.9L29.4 8.1L19.9 4Z";
const TAIL = "M2 0C-8 -11 -20 -12 -30 -7C-23 -6 -19 -3 -17 0C-23 0 -29 3 -33 9C-22 10 -9 8 2 0Z";
const SPINE =
  "M69.5 20.2 L73.5 13.1 L76.8 24.9ZM102 38.5 L106.3 30.1 L110.6 43.7ZM131.5 51.1 L133.7 40.7 L142.4 54.2ZM157.8 53.3 L155.3 41.8 L170.2 51.4ZM184.9 43.6 L178.2 32.7 L197 37.3ZM214.3 23.8 L205.8 12.8 L226.5 15.6ZM246 0.8 L238.2 -12 L260.1 -6.6ZM282.9 -16.9 L279.6 -31.6 L298.7 -19.4ZM324.7 -19.4 L327.8 -34.1 L340.1 -15ZM363.5 -4.9 L370.4 -18.3 L377.2 3.3ZM396.5 16.2 L403.9 3.1 L409.8 25ZM424.1 33.4 L429 19.3 L438.8 39.7ZM446.3 41.9 L445.5 26.9 L462.3 42.1ZM469.6 40.2 L463 26.7 L484.4 34.2ZM498.2 26.2 L489.2 14.1 L511.6 17.5ZM530.6 4.7 L522 -7.6 L544.3 -3.7ZM567.2 -14.9 L561.8 -28.9 L582.5 -19.7ZM609.1 -22.2 L609.9 -37.3 L624.9 -20.2ZM649.7 -11.9 L655.6 -25.8 L664 -4.7ZM684.7 8.3 L692.2 -4.8 L698 17.2ZM714.4 27.9 L720.7 14.2 L728.5 35.5ZM738.4 39.8 L740.1 24.8 L754.1 42.6ZM760.2 42.3 L755.5 28 L775.7 38.3ZM786.9 32.8 L778.5 20.3 L800.7 24.7ZM818.1 13.1 L809 1.1 L831.4 4.2ZM854.1 -5.6 L847.1 -18.9 L868.7 -12.1Z";
const VISOR =
  "M21.6 25.22L42.04 22.71C45.93 22.23 48.7 24.39 49.17 28.28L49.37 29.87C49.97 34.73 47.27 38.19 42.4 38.78L21.96 41.29C18.07 41.77 15.3 39.61 14.83 35.72L14.63 34.13C14.03 29.27 16.73 25.81 21.6 25.22Z";
const HEAD = `M35 10L45 10C52.35 10 57 14.65 57 22L57 26C57 44.82 47.82 54 29 54L19 54C11.65 54 7 49.35 7 42L7 38C7 19.18 16.18 10 35 10Z${VISOR}`;
const BAND = [
  "M6.94 22.82C6.89 23.09 6.71 23.9 6.6 24.44C6.5 24.97 6.39 25.51 6.29 26.05C6.19 26.59 6.09 27.13 6 27.68C5.91 28.22 5.82 28.76 5.74 29.3C5.65 29.85 5.57 30.39 5.5 30.94C5.42 31.48 5.35 32.03 5.28 32.57C5.21 33.12 5.15 33.66 5.09 34.21C5.03 34.76 4.95 35.58 4.92 35.86L6.22 34.74L7.2 36.14C7.24 35.88 7.37 35.08 7.46 34.55C7.55 34.01 7.65 33.48 7.75 32.96C7.85 32.43 7.95 31.9 8.06 31.37C8.16 30.85 8.28 30.32 8.39 29.8C8.51 29.27 8.62 28.75 8.75 28.23C8.87 27.71 8.99 27.19 9.12 26.67C9.25 26.15 9.39 25.63 9.53 25.12C9.66 24.6 9.88 23.83 9.95 23.57Z",
  "M7.24 22.39C7.13 22.57 6.8 23.11 6.58 23.47C6.37 23.84 6.15 24.2 5.94 24.57C5.73 24.94 5.52 25.31 5.31 25.68C5.1 26.05 4.9 26.42 4.7 26.79C4.5 27.16 4.3 27.54 4.1 27.91C3.91 28.29 3.72 28.67 3.53 29.05C3.34 29.43 3.15 29.81 2.96 30.19C2.78 30.57 2.51 31.15 2.42 31.34L3.88 30.8L4.29 32.3C4.39 32.12 4.7 31.58 4.91 31.22C5.11 30.87 5.33 30.51 5.54 30.16C5.75 29.81 5.97 29.45 6.19 29.1C6.41 28.75 6.63 28.41 6.85 28.06C7.07 27.72 7.3 27.37 7.53 27.03C7.76 26.69 7.99 26.35 8.22 26.01C8.45 25.67 8.69 25.34 8.93 25C9.17 24.67 9.53 24.17 9.65 24.01Z",
  "M10.82 21C25.73 17.96 40.65 16.19 55.57 15.71C55.67 15.62 56.38 17.23 56.73 19.08C40.84 19.52 24.94 21.42 9.05 24.77C7.78 28.03 8.96 24.17 10.82 21Z",
  "M8.01 20.29L9.38 20.41C10.68 20.53 11.46 21.46 11.35 22.76L11.23 24.13C11.12 25.43 10.18 26.21 8.88 26.1L7.52 25.98C6.21 25.87 5.43 24.93 5.54 23.63L5.66 22.27C5.78 20.96 6.71 20.18 8.01 20.29Z",
];
