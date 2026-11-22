import type { Point, SurveillanceZone } from './api';

const normalized = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000;

export function regionRectangle(first: Point, second: Point): Point[] | null {
  if (![...first, ...second].every(Number.isFinite)) return null;
  const left = normalized(Math.min(first[0], second[0])), right = normalized(Math.max(first[0], second[0]));
  const top = normalized(Math.min(first[1], second[1])), bottom = normalized(Math.max(first[1], second[1]));
  const width = right - left, height = bottom - top;
  if (width < .02 - 1e-8 || height < .02 - 1e-8 || width * height < .0025 - 1e-8) return null;
  return [[left, top], [right, top], [right, bottom], [left, bottom]];
}

export function regionBounds(points: Point[]): [number, number, number, number] {
  return [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
    Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))];
}

export function regionDraftChanged(saved: SurveillanceZone[], draft: SurveillanceZone[]): boolean {
  return JSON.stringify(saved) !== JSON.stringify(draft);
}
