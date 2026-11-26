import type { DozoShape } from "@rakazo/core";
import { dozoAvatarLayout, dozoBotColor, dozoCharacterForLook } from "@rakazo/core";
import type { ComponentType } from "react";
import type { ColorValue } from "react-native";
import { Ellipse, G, Path, Rect } from "react-native-svg";

type Shape = ComponentType<Record<string, string | number | ColorValue | undefined>>;
type Part = ReturnType<typeof dozoAvatarLayout>[number];
type Paints = Record<DozoShape[2], Record<string, string | number | ColorValue | undefined>>;

const SHAPES: Record<DozoShape[1], Shape> = {
  path: Path as unknown as Shape,
  circle: Ellipse as unknown as Shape,
  ellipse: Ellipse as unknown as Shape,
  rect: Rect as unknown as Shape,
};

export const LINE_WIDTH = 2.6;

export function paintsFor(foreground: string, accent: string): Paints {
  return {
    body: { fill: foreground, fillRule: "evenodd" },
    line: { fill: "none", stroke: foreground, strokeWidth: LINE_WIDTH, strokeLinecap: "round" },
    accent: { fill: accent },
  };
}

/** One shape of the drawing, in the paint its kind gets. */
function drawShape([, tag, kind, attrs]: DozoShape, key: number, paints: Paints) {
  const Tag = SHAPES[tag];
  // A circle is an ellipse of equal radii: one element fewer for the native host to know.
  const geometry = tag === "circle" ? { ...attrs, rx: attrs.r, ry: attrs.r, r: undefined } : attrs;
  return <Tag key={key} {...geometry} {...paints[kind]} />;
}

export function drawPart({ shapes }: Part, paints: Paints) {
  return shapes.map((shape, at) => drawShape(shape, at, paints));
}

/**
 * A character at rest for a group's row of faces, in a 64-unit box: the face as the bot's picture
 * draws it with nothing moving, and its silhouette, which the seat above it carves out. Kept apart
 * from the moving picture so a header that only draws seats loads no animation code.
 */
export function dozoSeatArt(identity: string | undefined, color: string, foreground: string) {
  const seed = identity || color || "bot";
  const character = dozoCharacterForLook(seed, color);
  const accent = dozoBotColor(seed, color) ?? foreground;
  const layout = dozoAvatarLayout(character);
  const draw = (paints: Paints) =>
    layout.map((part, index) => <G key={index}>{drawPart(part, paints)}</G>);
  return {
    box: [0, 0, 64] as [number, number, number],
    outline: (paint: { fill: ColorValue; stroke?: string; strokeWidth?: number }) => {
      const grown = paint.strokeWidth ?? 0;
      const cut = { fill: paint.fill, stroke: paint.stroke, strokeWidth: grown };
      return draw({
        body: cut,
        accent: cut,
        line: {
          fill: "none",
          stroke: paint.stroke ?? foreground,
          strokeWidth: LINE_WIDTH + grown,
          strokeLinecap: "round",
        },
      });
    },
    face: draw(paintsFor(foreground, accent)),
  };
}
