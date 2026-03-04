// Office types — source of truth for Rust mirror in src-tauri/src/models/agent_state.rs

export type LayoutSize = "small" | "medium" | "large" | "campus";

export interface GridPosition {
  col: number;
  row: number;
}

export interface ScreenPosition {
  x: number;
  y: number;
}

export interface DeskAssignment {
  agentId: string;
  position: GridPosition;
  isOccupied: boolean;
}

export type ZoneType =
  | "water_cooler"
  | "kitchen"
  | "sofa"
  | "meeting_room"
  | "standing_desk"
  | "bathroom"
  | "hr_zone"
  | "lounge";

export interface Zone {
  id: string;
  type: ZoneType;
  position: GridPosition;
  capacity: number;
  currentOccupants: string[];
}

export interface OfficeLayout {
  size: LayoutSize;
  width: number;
  height: number;
  desks: DeskAssignment[];
  zones: Zone[];
  walkableGrid: boolean[][];
}
