// NPC manager — spawns static NPC characters that roam between zones
// NPCs are not tied to real processes; they provide office ambience

import type { GridPosition, ZoneType } from "$lib/types/office";
import type { Tier } from "$lib/types/agent";
import type { Spritesheet } from "pixi.js";
import { AgentSprite } from "./AgentSprite";
import type { Pathfinder } from "./Pathfinder";

/** Scheduled routine that drives periodic NPC movement */
export interface NpcRoutine {
  targetZone: ZoneType;
  intervalMs: [number, number];
  dwellMs: [number, number];
}

/** Configuration for a single NPC character */
export interface NpcConfig {
  id: string;
  name: string;
  role: string;
  homePosition: GridPosition;
  tier: Tier;
  routines: NpcRoutine[];
}

/** Internal state for a managed NPC */
interface NpcState {
  config: NpcConfig;
  sprite: AgentSprite;
  timers: ReturnType<typeof setTimeout>[];
  isWalking: boolean;
}

/** Zone position resolver — returns a walkable position for a zone type */
export type ZonePositionResolver = (zoneType: ZoneType) => GridPosition | null;

/**
 * Manages NPC characters in the office scene.
 * NPCs spawn at their home position and periodically walk to various zones.
 */
export class NpcManager {
  private readonly npcs: Map<string, NpcState> = new Map();
  private pathfinder: Pathfinder | null = null;
  private zoneResolver: ZonePositionResolver | null = null;

  /**
   * Initialize the NPC manager with pathfinder and zone resolver.
   */
  setup(pathfinder: Pathfinder, zoneResolver: ZonePositionResolver): void {
    this.pathfinder = pathfinder;
    this.zoneResolver = zoneResolver;
  }

  /**
   * Spawn NPCs from layout configuration.
   * Returns the created AgentSprite instances for adding to the scene.
   */
  spawnNpcs(
    configs: NpcConfig[],
    sheetResolver: (tier: Tier) => Spritesheet | null
  ): AgentSprite[] {
    const sprites: AgentSprite[] = [];

    for (const config of configs) {
      const sheet = sheetResolver(config.tier);
      const sprite = new AgentSprite(
        {
          id: config.id,
          pid: null,
          name: config.name,
          model: "npc",
          tier: config.tier,
          role: config.role,
          status: "idle",
          idleLocation: "desk",
          currentTask: null,
          tokensIn: 0,
          tokensOut: 0,
          subAgents: [],
          lastActivity: new Date().toISOString(),
          source: "cli",
        },
        sheet
      );

      sprite.snapToGrid(config.homePosition);
      sprite.setState("idle");

      const state: NpcState = {
        config,
        sprite,
        timers: [],
        isWalking: false,
      };

      this.npcs.set(config.id, state);
      sprites.push(sprite);

      this.startRoutines(state);
    }

    return sprites;
  }

  /**
   * Stop all NPC timers and clean up.
   */
  destroy(): void {
    for (const npc of this.npcs.values()) {
      for (const timer of npc.timers) {
        clearTimeout(timer);
      }
      npc.timers.length = 0;
      npc.sprite.destroy();
    }
    this.npcs.clear();
  }

  /**
   * Get the NPC sprite by id.
   */
  getNpcSprite(id: string): AgentSprite | undefined {
    return this.npcs.get(id)?.sprite;
  }

  /**
   * Check if an id belongs to an NPC.
   */
  isNpc(id: string): boolean {
    return this.npcs.has(id);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private startRoutines(npc: NpcState): void {
    for (const routine of npc.config.routines) {
      this.scheduleRoutine(npc, routine);
    }
  }

  private scheduleRoutine(npc: NpcState, routine: NpcRoutine): void {
    const [minInterval, maxInterval] = routine.intervalMs;
    const delay = minInterval + Math.random() * (maxInterval - minInterval);

    const timer = setTimeout(() => {
      this.executeRoutine(npc, routine);
    }, delay);

    npc.timers.push(timer);
  }

  private executeRoutine(npc: NpcState, routine: NpcRoutine): void {
    if (npc.isWalking || this.pathfinder === null || this.zoneResolver === null) {
      this.scheduleRoutine(npc, routine);
      return;
    }

    const targetPos = this.zoneResolver(routine.targetZone);
    if (targetPos === null) {
      this.scheduleRoutine(npc, routine);
      return;
    }

    const currentPos = npc.sprite.getGridPosition();
    const path = this.pathfinder.findPath(currentPos, targetPos);

    if (path.length === 0) {
      this.scheduleRoutine(npc, routine);
      return;
    }

    npc.isWalking = true;
    npc.sprite.setState("walking_to_desk");
    npc.sprite.walkAlongPath(path, () => {
      npc.isWalking = false;
      npc.sprite.setState("idle");

      // Dwell at the zone
      const [minDwell, maxDwell] = routine.dwellMs;
      const dwell = minDwell + Math.random() * (maxDwell - minDwell);

      const dwellTimer = setTimeout(() => {
        this.returnHome(npc, routine);
      }, dwell);

      npc.timers.push(dwellTimer);
    });
  }

  private returnHome(npc: NpcState, routine: NpcRoutine): void {
    if (this.pathfinder === null) return;

    const currentPos = npc.sprite.getGridPosition();
    const homePath = this.pathfinder.findPath(currentPos, npc.config.homePosition);

    if (homePath.length === 0) {
      npc.sprite.snapToGrid(npc.config.homePosition);
      npc.sprite.setState("idle");
      this.scheduleRoutine(npc, routine);
      return;
    }

    npc.isWalking = true;
    npc.sprite.setState("walking_to_desk");
    npc.sprite.walkAlongPath(homePath, () => {
      npc.isWalking = false;
      npc.sprite.snapToGrid(npc.config.homePosition);
      npc.sprite.setState("idle");
      this.scheduleRoutine(npc, routine);
    });
  }
}
