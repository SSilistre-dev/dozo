/** `YYYY-MM-DD` of the day it is where the person is, for a file they download today. */
export function dozoLocalDay(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
