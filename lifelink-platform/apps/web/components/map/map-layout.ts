export function hasMeasurableMapSize(width: number, height: number) {
  return width > 0 && height > 0;
}

export type MapCoordinates = readonly [number, number];

export function isValidMapCoordinates(value: readonly [number | null | undefined, number | null | undefined] | null | undefined): value is MapCoordinates {
  return Boolean(value && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Math.abs(value[0]!) <= 90 && Math.abs(value[1]!) <= 180);
}
