import { createContext, useContext } from 'react';
import type { SurveillanceNotice, SurveillancePin } from './api';

export type WatchTarget = { cameraId: number; trackId?: string; notice?: SurveillanceNotice; pin?: SurveillancePin };
export type PinSelection = { camera_id: number; track_id: string; track_number: number; label: string };
export const SurveillanceContext = createContext<{
  unread: number;
  pins: SurveillancePin[];
  error: string;
  canManage: boolean;
  refresh: () => void;
  read: (ids?: string[]) => Promise<void>;
  pin: (value: PinSelection) => Promise<void>;
  unpin: (id: string) => Promise<void>;
  watch: (target: WatchTarget) => void;
} | null>(null);
export const useSurveillance = () => useContext(SurveillanceContext);
