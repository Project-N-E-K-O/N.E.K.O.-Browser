import type { SnapshotInfo } from "@/lib/connection-controller";

export const POPUP_PORT_NAME = "bsk-popup";

export type PopupOutbound =
  | { kind: "set_label"; value: string }
  | { kind: "set_port"; value: number }
  | { kind: "set_connection_enabled"; value: boolean };

export type PopupInbound = { kind: "snapshot"; data: SnapshotInfo };
