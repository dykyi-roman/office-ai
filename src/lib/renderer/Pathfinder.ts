// A* pathfinder on an isometric boolean grid
// Supports 8-directional movement, LRU path cache, max 50-tile paths

import type { GridPosition } from "$lib/types/office";
import type { IdleLocation } from "$lib/types/agent";

/** Maximum path length in tiles before truncation */
const MAX_PATH_LENGTH = 50;

/** LRU cache capacity for frequently used routes */
const CACHE_CAPACITY = 64;

/** Octile distance heuristic weight */
const SQRT2 = Math.SQRT2;

/** 8-directional movement vectors [col-delta, row-delta, cost] */
const DIRECTIONS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [-1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, -1, SQRT2],
];

/** Internal A* node */
interface AStarNode {
  col: number;
  row: number;
  g: number; // cost from start
  f: number; // g + heuristic
  parent: AStarNode | null;
}

/** Serialise a GridPosition to a cache/closed-set key */
function posKey(col: number, row: number): string {
  return `${col},${row}`;
}

/** Octile distance heuristic for 8-directional movement */
function heuristic(ac: number, ar: number, bc: number, br: number): number {
  const dc = Math.abs(ac - bc);
  const dr = Math.abs(ar - br);
  return dc + dr + (SQRT2 - 2) * Math.min(dc, dr);
}

/**
 * Minimal binary min-heap for A* open list.
 * Compares nodes by their f-value.
 */
class MinHeap {
  private readonly data: AStarNode[] = [];

  get size(): number {
    return this.data.length;
  }

  push(node: AStarNode): void {
    this.data.push(node);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): AStarNode | undefined {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0 && last !== undefined) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[parent].f <= this.data[i].f) break;
      [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.data[l].f < this.data[smallest].f) smallest = l;
      if (r < n && this.data[r].f < this.data[smallest].f) smallest = r;
      if (smallest === i) break;
      [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
      i = smallest;
    }
  }
}

/**
 * LRU cache with a fixed capacity.
 * Evicts the least-recently-used entry when full.
 */
class LruCache<V> {
  private readonly map: Map<string, V>;
  private readonly cap: number;

  constructor(capacity: number) {
    this.cap = capacity;
    this.map = new Map();
  }

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Re-insert to mark as most-recently-used
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.cap) {
      // Evict the first (oldest) entry
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Zone-type to candidate positions mapping (populated from layout) */
type ZonePositions = Map<IdleLocation, GridPosition[]>;

/**
 * A* pathfinder operating on a 2-D walkable boolean grid.
 * Walkable grid: walkable[row][col] === true means the tile is passable.
 */
export class Pathfinder {
  private walkable: boolean[][];
  private readonly cols: number;
  private readonly rows: number;
  private readonly cache: LruCache<GridPosition[]>;
  private zonePositions: ZonePositions = new Map();
  private deskPositions: GridPosition[] = [];

  constructor(walkable: boolean[][]) {
    this.walkable = walkable;
    this.rows = walkable.length;
    this.cols = walkable[0]?.length ?? 0;
    this.cache = new LruCache(CACHE_CAPACITY);
  }

  /**
   * Update the walkable grid (e.g. when a desk becomes occupied).
   * Clears path cache because old paths may be invalid.
   */
  updateWalkable(walkable: boolean[][]): void {
    this.walkable = walkable;
    this.cache.clear();
  }

  /**
   * Register idle-zone positions for use by getRandomIdlePosition.
   */
  setZonePositions(positions: ZonePositions): void {
    this.zonePositions = positions;
  }

  /**
   * Register desk positions for use by getNearestDesk.
   */
  setDeskPositions(desks: GridPosition[]): void {
    this.deskPositions = desks;
  }

  /**
   * Find a path from `from` to `to` using A*.
   * Returns an array of grid positions starting from the step *after* `from`
   * and ending at `to`. Returns an empty array if no path exists.
   * Paths longer than MAX_PATH_LENGTH tiles are truncated.
   */
  findPath(from: GridPosition, to: GridPosition): GridPosition[] {
    if (!this.isWalkable(to.col, to.row)) return [];
    if (from.col === to.col && from.row === to.row) return [];

    const cacheKey = `${posKey(from.col, from.row)}->${posKey(to.col, to.row)}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const open = new MinHeap();
    const closed = new Set<string>();
    const gScores = new Map<string, number>();

    const startNode: AStarNode = {
      col: from.col,
      row: from.row,
      g: 0,
      f: heuristic(from.col, from.row, to.col, to.row),
      parent: null,
    };

    open.push(startNode);
    gScores.set(posKey(from.col, from.row), 0);

    while (open.size > 0) {
      const current = open.pop()!;
      const currentKey = posKey(current.col, current.row);

      if (closed.has(currentKey)) continue;
      closed.add(currentKey);

      if (current.col === to.col && current.row === to.row) {
        const path = this.reconstructPath(current);
        const truncated = path.slice(0, MAX_PATH_LENGTH);
        this.cache.set(cacheKey, truncated);
        return truncated;
      }

      for (const [dc, dr, cost] of DIRECTIONS) {
        const nc = current.col + dc;
        const nr = current.row + dr;
        const nKey = posKey(nc, nr);

        if (!this.isWalkable(nc, nr)) continue;
        if (closed.has(nKey)) continue;

        // For diagonal movement, ensure both cardinal neighbours are walkable
        if (dc !== 0 && dr !== 0) {
          if (!this.isWalkable(current.col + dc, current.row)) continue;
          if (!this.isWalkable(current.col, current.row + dr)) continue;
        }

        const tentativeG = current.g + cost;
        const existingG = gScores.get(nKey);
        if (existingG !== undefined && tentativeG >= existingG) continue;

        gScores.set(nKey, tentativeG);
        open.push({
          col: nc,
          row: nr,
          g: tentativeG,
          f: tentativeG + heuristic(nc, nr, to.col, to.row),
          parent: current,
        });
      }
    }

    // No path found
    this.cache.set(cacheKey, []);
    return [];
  }

  /**
   * Return a random walkable position within the given idle zone type.
   * Falls back to a random walkable tile if no zone positions are registered.
   */
  getRandomIdlePosition(zone: IdleLocation): GridPosition {
    const positions = this.zonePositions.get(zone) ?? [];
    if (positions.length > 0) {
      return positions[Math.floor(Math.random() * positions.length)];
    }
    // Fallback: pick any walkable tile
    return this.randomWalkable();
  }

  /**
   * Return the walkable desk position nearest to the origin (0,0) that is
   * not excluded by the provided agent-id list.
   * Returns grid (0,0) as last-resort fallback.
   */
  getNearestDesk(exclude: string[]): GridPosition {
    // exclude parameter contains agent IDs — caller filters desks externally.
    // We expose this method so callers can pass desks already filtered.
    const available = this.deskPositions.filter(
      (_, idx) => !exclude.includes(String(idx))
    );
    if (available.length === 0) {
      return this.deskPositions[0] ?? { col: 0, row: 0 };
    }
    return available.reduce((best, pos) => {
      const bd = best.col + best.row;
      const pd = pos.col + pos.row;
      return pd < bd ? pos : best;
    });
  }

  /**
   * Return the nearest walkable tile adjacent to the given position.
   * Useful for navigating to unwalkable tiles like desks — walk to a neighbour.
   * Returns the position itself if it is already walkable.
   */
  nearestWalkableNeighbor(pos: GridPosition): GridPosition | null {
    if (this.isWalkable(pos.col, pos.row)) return pos;

    for (const [dc, dr] of DIRECTIONS) {
      const nc = pos.col + dc;
      const nr = pos.row + dr;
      if (this.isWalkable(nc, nr)) {
        return { col: nc, row: nr };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private isWalkable(col: number, row: number): boolean {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return false;
    return this.walkable[row]?.[col] === true;
  }

  private reconstructPath(node: AStarNode): GridPosition[] {
    const path: GridPosition[] = [];
    let current: AStarNode | null = node;
    while (current !== null) {
      path.unshift({ col: current.col, row: current.row });
      current = current.parent;
    }
    // Remove start node (index 0) — caller already knows from-position
    return path.slice(1);
  }

  private randomWalkable(): GridPosition {
    const candidates: GridPosition[] = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.walkable[r]?.[c]) candidates.push({ col: c, row: r });
      }
    }
    if (candidates.length === 0) return { col: 0, row: 0 };
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
}
