// OfficeScene — main PixiJS isometric office scene
// Initialises the application, loads layouts, manages agent sprites, subscribes to Tauri events

import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Spritesheet,
  Texture,
} from "pixi.js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AgentState, Status, Tier } from "$lib/types/agent";
import type { OfficeLayout, GridPosition } from "$lib/types/office";
import {
  TAURI_EVENTS,
  type AgentFoundPayload,
  type AgentLostPayload,
  type AgentStateChangedPayload,
  type OfficeLayoutChangedPayload,
} from "$lib/types/events";

import { isoToScreen } from "./utils/isometric";
import { Pathfinder } from "./Pathfinder";
import { DeskManager } from "./DeskManager";
import { CameraController } from "./CameraController";
import { AgentSprite } from "./AgentSprite";
import { IdleZoneManager } from "./IdleZoneManager";
import { NpcManager, type NpcConfig } from "./NpcManager";
import { getSetting } from "$lib/stores/settings.svelte";
import { t } from "$lib/i18n";

import mediumLayout from "./layouts/medium.json";

// ---------------------------------------------------------------------------
// Agent location tracking
// ---------------------------------------------------------------------------

type AgentLocationState = "idle_zone" | "desk" | "walking_to_desk" | "walking_to_idle";

const WORK_STATUSES: ReadonlySet<Status> = new Set(["thinking", "responding", "tool_use"]);
const IDLE_STATUSES: ReadonlySet<Status> = new Set(["idle", "collaboration"]);
const LEAVE_DESK_STATUSES: ReadonlySet<Status> = new Set(["error"]);

/** Pixel offsets so agents at the same tile don't visually overlap.
 *  Each slot gets a unique isometric offset (±24px horizontal, ±12px vertical). */
const SLOT_OFFSETS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: 0 },
  { x: 24, y: -12 },
  { x: -24, y: -12 },
  { x: 0, y: -24 },
];

/** Pixel offset to position agent between the desk and the chair.
 *  Shifts half a tile from chair toward desk in isometric screen space. */
const DESK_SEAT_OFFSET: Readonly<{ x: number; y: number }> = { x: 32, y: -16 };

function slotPixelOffset(slotIndex: number): { x: number; y: number } {
  return SLOT_OFFSETS[slotIndex % SLOT_OFFSETS.length];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Tile entry from the layout JSON (tiles array) */
interface TileEntry {
  col: number;
  row: number;
  type: string;
}

/** Furniture entry from the layout JSON */
interface FurnitureEntry {
  col: number;
  row: number;
  type: string;
  rotation: number;
}

/** Layout JSON shape as loaded from disk */
interface LayoutJson {
  size: string;
  width: number;
  height: number;
  tiles: TileEntry[];
  furniture: FurnitureEntry[];
  desks: Array<{ agentId: string; position: GridPosition; isOccupied: boolean }>;
  zones: Array<{
    id: string;
    type: string;
    position: GridPosition;
    capacity: number;
    currentOccupants: string[];
  }>;
  npcs?: NpcConfig[];
  entrance?: GridPosition;
  walkableGrid: boolean[][];
}

/** Map from agent count range to layout size */
const LAYOUT_THRESHOLDS: Array<{ maxAgents: number; size: string }> = [
  { maxAgents: 4, size: "small" },
  { maxAgents: 10, size: "medium" },
  { maxAgents: 20, size: "large" },
  { maxAgents: Infinity, size: "campus" },
];

/** Priority for desk tier assignment */
const PRIORITY_DESK_COUNT_MEDIUM = 2;

/**
 * Main isometric office scene.
 * Manages PixiJS Application lifecycle, rendering layers, agent sprites,
 * pathfinding, desk assignments, and Tauri event subscriptions.
 */
export class OfficeScene {
  private app: Application | null = null;
  private container: HTMLElement | null = null;

  // Rendering layers (z-ordered)
  private readonly world: Container = new Container();
  private readonly floorLayer: Container = new Container();
  private readonly furnitureLayer: Container = new Container();
  private readonly agentLayer: Container = new Container();
  private readonly effectLayer: Container = new Container();
  private readonly uiLayer: Container = new Container();

  // Sub-systems
  private readonly deskManager: DeskManager = new DeskManager();
  private readonly idleZoneManager: IdleZoneManager = new IdleZoneManager();
  private readonly npcManager: NpcManager = new NpcManager();
  private pathfinder: Pathfinder = new Pathfinder([]);
  private camera: CameraController | null = null;

  // Agent state
  private readonly agentSprites: Map<string, AgentSprite> = new Map();
  private readonly agentLocation: Map<string, AgentLocationState> = new Map();
  private selectedAgentId: string | null = null;

  // Loaded spritesheets
  private readonly agentSheets: Map<Tier, Spritesheet | null> = new Map();
  private tilesheet: Spritesheet | null = null;

  // Entrance position for agent spawn/exit
  private entrancePos: GridPosition = { col: 1, row: 1 };

  // Current layout dimensions
  private layoutWidth = 0;
  private layoutHeight = 0;

  // Tauri event unsubscribe functions
  private readonly unlisteners: UnlistenFn[] = [];

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Initialise the PixiJS application inside the given DOM container.
   * Loads assets, renders the default medium layout, and subscribes to Tauri events.
   */
  async init(container: HTMLElement): Promise<void> {
    this.container = container;
    this.app = new Application();
    await this.app.init({
      width: container.clientWidth,
      height: container.clientHeight,
      backgroundColor: 0x1a1a2e,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    container.appendChild(this.app.canvas);

    // Build rendering layer hierarchy
    this.world.addChild(this.floorLayer);
    this.world.addChild(this.furnitureLayer);
    this.world.addChild(this.agentLayer);
    this.world.addChild(this.effectLayer);
    this.world.addChild(this.uiLayer);

    this.agentLayer.sortableChildren = true;
    this.app.stage.addChild(this.world);

    // Camera controller
    this.camera = new CameraController(this.world);
    this.camera.attach(
      this.app.canvas,
      container.clientWidth,
      container.clientHeight
    );
    this.camera.setClickHandler((x, y) => this.handleCanvasClick(x, y));

    // Adaptive resize
    const resizeObserver = new ResizeObserver(() => {
      if (this.app && this.container) {
        this.app.renderer.resize(
          this.container.clientWidth,
          this.container.clientHeight
        );
        this.camera?.resize(
          this.container.clientWidth,
          this.container.clientHeight
        );
      }
    });
    resizeObserver.observe(container);

    // Load assets (non-blocking; scene renders with fallbacks if assets are absent)
    await this.loadAssets();

    // Render the default medium layout
    await this.loadLayoutJson(mediumLayout as unknown as LayoutJson);

    // Subscribe to Tauri events (non-fatal — gracefully skip in dev mode)
    try {
      await this.subscribeToEvents();
    } catch {
      // Tauri not available (browser dev mode) — events handled via store fallback
    }

    // Load existing agents from backend (supports page reload)
    await this.loadExistingAgents();

    // Centre the camera on the layout
    this.camera.centerOn(
      Math.floor(this.layoutWidth / 2),
      Math.floor(this.layoutHeight / 2)
    );
  }

  /**
   * Clean up all resources, remove the canvas, and unsubscribe events.
   */
  destroy(): void {
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners.length = 0;

    this.npcManager.destroy();

    for (const sprite of this.agentSprites.values()) {
      sprite.destroy();
    }
    this.agentSprites.clear();

    this.camera?.detach();
    this.camera = null;

    if (this.app) {
      this.app.destroy(true, { children: true });
      this.app = null;
    }
  }

  /** Max distance (world pixels) from sprite centre to count as a hit */
  private static readonly HIT_RADIUS = 48;

  /**
   * Return the agent ID at the given screen coordinates, or null.
   * Uses pixel-proximity to handle sprites offset from grid centres.
   */
  getAgentAtPosition(screenX: number, screenY: number): string | null {
    const worldX = (screenX - this.world.x) / this.world.scale.x;
    const worldY = (screenY - this.world.y) / this.world.scale.y;

    let closest: string | null = null;
    let closestDist = OfficeScene.HIT_RADIUS;

    for (const [id, sprite] of this.agentSprites) {
      const dx = sprite.x - worldX;
      const dy = sprite.y - worldY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        closest = id;
      }
    }
    return closest;
  }

  /**
   * Handle a canvas click — select or deselect agent.
   */
  private handleCanvasClick(screenX: number, screenY: number): void {
    const agentId = this.getAgentAtPosition(screenX, screenY);
    if (agentId !== null) {
      this.selectAgent(agentId);
      window.dispatchEvent(
        new CustomEvent("office:select-agent", { detail: { id: agentId } }),
      );
    } else {
      this.selectAgent(null);
      window.dispatchEvent(new CustomEvent("office:deselect-agent"));
    }
  }

  /**
   * Select (highlight) an agent by ID. Deselects any previously selected agent.
   * Pass null to clear selection.
   */
  selectAgent(id: string | null): void {
    if (this.selectedAgentId !== null) {
      this.agentSprites.get(this.selectedAgentId)?.setSelected(false);
    }
    this.selectedAgentId = id;
    if (id !== null) {
      const sprite = this.agentSprites.get(id);
      if (sprite !== undefined) {
        sprite.setSelected(true);
        this.camera?.follow(sprite);
      }
    } else {
      this.camera?.follow(null);
    }
  }

  /**
   * Replace the current office layout with the provided one.
   * Rebuilds tiles, furniture, and zone/desk data.
   * Existing agent sprites are repositioned to new desks.
   */
  setLayout(layout: OfficeLayout): void {
    // Convert OfficeLayout into our internal LayoutJson-like structure
    const json: LayoutJson = {
      size: layout.size,
      width: layout.width,
      height: layout.height,
      tiles: [], // tiles not part of OfficeLayout — use empty (renders blank floor)
      furniture: [],
      desks: layout.desks.map((d) => ({
        agentId: d.agentId,
        position: d.position,
        isOccupied: d.isOccupied,
      })),
      zones: layout.zones.map((z) => ({
        id: z.id,
        type: z.type,
        position: z.position,
        capacity: z.capacity,
        currentOccupants: [...z.currentOccupants],
      })),
      walkableGrid: layout.walkableGrid,
    };

    void this.loadLayoutJson(json);
  }

  // ---------------------------------------------------------------------------
  // Private: asset loading
  // ---------------------------------------------------------------------------

  private async loadSpritesheetFromUrl(jsonUrl: string): Promise<Spritesheet> {
    const jsonRes = await fetch(jsonUrl);
    if (!jsonRes.ok) throw new Error(`HTTP ${jsonRes.status} for ${jsonUrl}`);
    const data = await jsonRes.json();

    const dir = jsonUrl.substring(0, jsonUrl.lastIndexOf("/") + 1);
    const imageUrl = dir + (data.meta?.image ?? "");

    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status} for ${imageUrl}`);
    const blob = await imgRes.blob();
    const bitmap = await createImageBitmap(blob);
    const texture = Texture.from({ resource: bitmap, label: imageUrl });

    const sheet = new Spritesheet(texture, data);
    await sheet.parse();
    return sheet;
  }

  private async loadAssets(): Promise<void> {
    const tiers: Tier[] = ["expert", "senior", "middle", "junior"];
    const tierFilenames: Record<Tier, string> = {
      expert: "expert",
      senior: "senior",
      middle: "middle",
      junior: "junior",
    };

    await Promise.allSettled(
      tiers.map(async (tier) => {
        try {
          const jsonPath = `/static/sprites/agents/${tierFilenames[tier]}.json`;
          const sheet = await this.loadSpritesheetFromUrl(jsonPath);
          this.agentSheets.set(tier, sheet);
        } catch {
          console.warn(`[OfficeScene] Could not load spritesheet for tier: ${tier}`);
          this.agentSheets.set(tier, null);
        }
      })
    );

    try {
      this.tilesheet = await this.loadSpritesheetFromUrl(
        "/static/tiles/office-tileset.json"
      );
    } catch {
      console.warn("[OfficeScene] Could not load tile spritesheet — using fallbacks");
      this.tilesheet = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: layout loading
  // ---------------------------------------------------------------------------

  private async loadLayoutJson(json: LayoutJson): Promise<void> {
    this.layoutWidth = json.width;
    this.layoutHeight = json.height;
    this.entrancePos = json.entrance ?? { col: 1, row: 1 };

    // Clear existing layers
    this.floorLayer.removeChildren();
    this.furnitureLayer.removeChildren();

    // Render floor and wall tiles
    for (const tile of json.tiles) {
      const sprite = this.createTileSprite(tile.type, tile.col, tile.row);
      this.floorLayer.addChild(sprite);
    }

    // Render furniture
    for (const item of json.furniture) {
      const sprite = this.createTileSprite(item.type, item.col, item.row);
      this.furnitureLayer.addChild(sprite);
    }

    // Setup pathfinder
    this.pathfinder = new Pathfinder(json.walkableGrid);

    // Load desks and zones
    const validZoneTypes = [
      "water_cooler",
      "sofa",
      "meeting_room",
      "standing_desk",
      "lounge",
    ] as const;
    type ValidZoneType = (typeof validZoneTypes)[number];

    const isValidZoneType = (t: string): t is ValidZoneType =>
      (validZoneTypes as readonly string[]).includes(t);

    const filteredZones = json.zones
      .filter((z) => isValidZoneType(z.type))
      .map((z) => ({
        id: z.id,
        type: z.type as ValidZoneType,
        position: z.position,
        capacity: z.capacity,
        currentOccupants: [...z.currentOccupants],
      }));

    this.idleZoneManager.loadZones(filteredZones);
    this.deskManager.loadDesks(json.desks, PRIORITY_DESK_COUNT_MEDIUM);
    this.pathfinder.setDeskPositions(this.deskManager.getAllDeskPositions());

    // Initialize NPCs
    this.npcManager.destroy();
    if (json.npcs !== undefined && json.npcs.length > 0) {
      const zonePositions = new Map(
        filteredZones.map((z) => [z.type, z.position])
      );
      this.npcManager.setup(
        this.pathfinder,
        (zoneType) => zonePositions.get(zoneType) ?? null
      );
      const npcSprites = this.npcManager.spawnNpcs(
        json.npcs,
        (tier) => this.agentSheets.get(tier) ?? null
      );
      for (const sprite of npcSprites) {
        this.agentLayer.addChild(sprite);
      }
    }

    // Update camera world bounds
    this.camera?.setWorldBounds(json.width, json.height);
  }

  // ---------------------------------------------------------------------------
  // Private: tile / furniture sprite creation
  // ---------------------------------------------------------------------------

  private createTileSprite(
    tileType: string,
    col: number,
    row: number
  ): Container {
    const screen = isoToScreen(col, row);
    let sprite: Sprite;

    if (this.tilesheet !== null && this.tilesheet.textures[tileType]) {
      sprite = new Sprite(this.tilesheet.textures[tileType]);
    } else {
      // Fallback: draw a coloured isometric diamond
      const g = new Graphics();
      this.drawFallbackTile(g, tileType);
      const wrapper = new Container();
      wrapper.addChild(g);
      wrapper.x = screen.x;
      wrapper.y = screen.y;
      wrapper.zIndex = col + row;
      return wrapper;
    }

    sprite.anchor.set(0.5, 1);
    sprite.x = screen.x;
    sprite.y = screen.y;
    sprite.zIndex = col + row;
    return sprite;
  }

  private drawFallbackTile(g: Graphics, tileType: string): void {
    const color = this.fallbackColor(tileType);
    const isWall = tileType.startsWith("wall") || tileType.startsWith("internal_wall");
    const wallHeight = 40;

    if (isWall) {
      // Raised wall: draw side faces then top diamond
      const darkerColor = this.darkenColor(color, 0.6);
      const sideColor = this.darkenColor(color, 0.75);

      // Left face
      g.moveTo(0, 32);
      g.lineTo(64, 64);
      g.lineTo(64, 64 + wallHeight);
      g.lineTo(0, 32 + wallHeight);
      g.closePath();
      g.fill({ color: darkerColor });

      // Right face
      g.moveTo(64, 64);
      g.lineTo(128, 32);
      g.lineTo(128, 32 + wallHeight);
      g.lineTo(64, 64 + wallHeight);
      g.closePath();
      g.fill({ color: sideColor });

      // Top diamond
      g.moveTo(64, 0);
      g.lineTo(128, 32);
      g.lineTo(64, 64);
      g.lineTo(0, 32);
      g.closePath();
      g.fill({ color });
      g.stroke({ color: 0x000000, width: 0.5, alpha: 0.3 });

      g.x = -64;
      g.y = -64 - wallHeight;
    } else {
      // Flat floor tile
      g.moveTo(64, 0);
      g.lineTo(128, 32);
      g.lineTo(64, 64);
      g.lineTo(0, 32);
      g.closePath();
      g.fill({ color });
      g.stroke({ color: 0x000000, width: 0.5, alpha: 0.15 });
      g.x = -64;
      g.y = -64;
    }
  }

  private darkenColor(color: number, factor: number): number {
    const r = Math.floor(((color >> 16) & 0xff) * factor);
    const g = Math.floor(((color >> 8) & 0xff) * factor);
    const b = Math.floor((color & 0xff) * factor);
    return (r << 16) | (g << 8) | b;
  }

  private fallbackColor(tileType: string): number {
    const colorMap: Record<string, number> = {
      floor_wood: 0xc8a96e,
      floor_carpet: 0x7b9eaa,
      floor_tile: 0xd4d4d4,
      wall_left: 0x8b7355,
      wall_left_solid: 0x8b7355,
      wall_right: 0x6b5a3e,
      wall_right_solid: 0x6b5a3e,
      wall_corner: 0x5a4a30,
      desk_standard: 0x8b6914,
      desk_lead: 0x4a3d1e,
      desk_standing: 0x6e5a2a,
      water_cooler: 0x4fc3f7,
      coffee_machine: 0x795548,
      sofa_2seat: 0x7986cb,
      sofa_3seat: 0x5c6bc0,
      whiteboard: 0xf5f5f5,
      bookshelf: 0x8d6e63,
      plant_small: 0x4caf50,
      plant_large: 0x2e7d32,
      fridge: 0xf5f5f5,
      microwave: 0x333333,
      sink: 0xb0bec5,
      kitchen_table: 0xd4a96a,
      toilet: 0xf5f5f5,
      bathroom_sink: 0xe3f2fd,
      pouf: 0xe8b84b,
      hr_desk: 0xb8916a,
      door: 0xd4c9b0,
      internal_wall_left: 0xc2b9a6,
      internal_wall_right: 0xc2b9a6,
      chair_n: 0x4a5568,
      chair_s: 0x4a5568,
      chair_e: 0x4a5568,
      chair_w: 0x4a5568,
    };
    return colorMap[tileType] ?? 0xaaaaaa;
  }

  // ---------------------------------------------------------------------------
  // Private: Tauri event subscriptions
  // ---------------------------------------------------------------------------

  private async subscribeToEvents(): Promise<void> {
    const foundUn = await listen<AgentFoundPayload>(
      TAURI_EVENTS.AGENT_FOUND,
      (event) => {
        this.onAgentFound(event.payload.agent);
      }
    );

    const lostUn = await listen<AgentLostPayload>(
      TAURI_EVENTS.AGENT_LOST,
      (event) => {
        this.onAgentLost(event.payload.id);
      }
    );

    const changedUn = await listen<AgentStateChangedPayload>(
      TAURI_EVENTS.AGENT_STATE_CHANGED,
      (event) => {
        this.onAgentStateChanged(event.payload.agent);
      }
    );

    const layoutUn = await listen<OfficeLayoutChangedPayload>(
      TAURI_EVENTS.OFFICE_LAYOUT_CHANGED,
      (event) => {
        this.setLayout(event.payload.layout);
      }
    );

    this.unlisteners.push(foundUn, lostUn, changedUn, layoutUn);
  }

  // ---------------------------------------------------------------------------
  // Private: load existing agents from backend on init/reload
  // ---------------------------------------------------------------------------

  private async loadExistingAgents(): Promise<void> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const agents = await invoke<AgentState[]>("get_all_agents");
      for (const agent of agents) {
        this.restoreAgent(agent);
      }
    } catch {
      // Tauri not available (dev mode) or backend not ready — load from store
      try {
        const { getAllAgents } = await import("$lib/stores/agents.svelte");
        const storeAgents = getAllAgents();
        for (const agent of storeAgents) {
          this.restoreAgent(agent);
        }
      } catch {
        // Store not ready yet
      }
    }
  }

  /** Restore an agent after page reload.
   *  Spawns at entrance, then walks to the correct position based on status. */
  private restoreAgent(agent: AgentState): void {
    if (this.agentSprites.has(agent.id)) return;

    // Enforce maxAgents limit
    const maxAgents = getSetting("maxAgents");
    if (this.agentSprites.size >= maxAgents) return;

    this.maybeSwitchLayout(this.agentSprites.size + 1);

    const sheet = this.agentSheets.get("middle") ?? null;
    const sprite = new AgentSprite(agent, sheet);
    this.agentLayer.addChild(sprite);
    this.agentSprites.set(agent.id, sprite);

    // Spawn at entrance
    sprite.snapToGrid({ ...this.entrancePos });

    if (WORK_STATUSES.has(agent.status)) {
      // Agent was working — walk to desk
      this.moveAgentToDesk(agent.id, sprite, agent);
    } else {
      // Agent was idle — walk to idle zone
      this.walkAgentToIdleZone(agent.id, sprite);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: agent event handlers
  // ---------------------------------------------------------------------------

  private onAgentFound(agent: AgentState): void {
    if (this.agentSprites.has(agent.id)) {
      this.onAgentStateChanged(agent);
      return;
    }

    // Enforce maxAgents limit
    const maxAgents = getSetting("maxAgents");
    if (this.agentSprites.size >= maxAgents) return;

    // Check if we need to switch layout based on agent count
    this.maybeSwitchLayout(this.agentSprites.size + 1);

    const sheet = this.agentSheets.get("middle") ?? null;
    const sprite = new AgentSprite(agent, sheet);
    this.agentLayer.addChild(sprite);
    this.agentSprites.set(agent.id, sprite);

    // Snap to entrance
    const spawnPos: GridPosition = { ...this.entrancePos };
    sprite.snapToGrid(spawnPos);

    // Show greeting at entrance before walking
    if (getSetting("showPrompts")) {
      sprite.showSpeechBubble(t("agent.greeting"), 2000);
    }

    // If agent is already working, go directly to desk; otherwise idle zone
    if (WORK_STATUSES.has(agent.status)) {
      this.moveAgentToDesk(agent.id, sprite, agent);
    } else {
      this.walkAgentToIdleZone(agent.id, sprite);
    }
  }

  private onAgentLost(agentId: string): void {
    const sprite = this.agentSprites.get(agentId);
    if (sprite === undefined) return;

    // Release desk and idle zone immediately
    this.deskManager.releaseDesk(agentId);
    this.idleZoneManager.removeAgent(agentId);
    this.agentLocation.delete(agentId);

    if (getSetting("showPrompts")) {
      sprite.showSpeechBubble(t("agent.farewell"), 2000);
    }

    sprite.setState("walking_to_desk");

    // Find nearest walkable tile to entrance and walk there
    const entranceTarget = this.pathfinder.nearestWalkableNeighbor(this.entrancePos)
      ?? this.entrancePos;
    const currentPos = sprite.getGridPosition();
    const path = this.pathfinder.findPath(currentPos, entranceTarget);

    const removeAgent = () => {
      if (this.agentSprites.has(agentId)) {
        sprite.destroy();
        this.agentLayer.removeChild(sprite);
        this.agentSprites.delete(agentId);
        this.maybeSwitchLayout(this.agentSprites.size);
      }
    };

    if (path.length > 0) {
      sprite.walkAlongPath(path, removeAgent);
    } else {
      // No path found — fallback: snap-remove after 1s
      sprite.setState("offline");
      setTimeout(removeAgent, 1000);
    }
  }

  private onAgentStateChanged(agent: AgentState): void {
    const sprite = this.agentSprites.get(agent.id);
    if (sprite === undefined) {
      this.onAgentFound(agent);
      return;
    }

    const location = this.agentLocation.get(agent.id);
    const isWork = WORK_STATUSES.has(agent.status);
    const isIdle = IDLE_STATUSES.has(agent.status);

    if ((location === "idle_zone" || location === "walking_to_idle") && isWork) {
      // Agent received a task — move from idle zone to desk
      this.moveAgentToDesk(agent.id, sprite, agent);
    } else if ((location === "desk" || location === "walking_to_desk") && (isIdle || LEAVE_DESK_STATUSES.has(agent.status))) {
      // Agent finished task or encountered error — move from desk to idle zone
      sprite.update(agent);
      this.moveAgentToIdleZone(agent.id, sprite);
    } else {
      // Visual-only update (already at desk working, or transitional state)
      sprite.update(agent);
    }

    // Show speech bubble with currentTask when agent is working
    if (getSetting("showPrompts") && isWork && agent.currentTask) {
      sprite.showSpeechBubble(agent.currentTask);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: agent movement helpers
  // ---------------------------------------------------------------------------

  private walkAgentToIdleZone(agentId: string, sprite: AgentSprite): void {
    const assignment = this.idleZoneManager.assignIdleZone(agentId, () => {
      this.onIdleRotation(agentId);
    });

    if (assignment === null) {
      // All zones full — snap to random walkable tile
      const fallback = this.pathfinder.getRandomIdlePosition("desk");
      sprite.snapToGrid(fallback);
      sprite.setState("idle");
      this.agentLocation.set(agentId, "idle_zone");
      return;
    }

    const zonePos = assignment.slot;
    const pixelOffset = slotPixelOffset(assignment.slotIndex);
    const walkTarget = this.pathfinder.nearestWalkableNeighbor(zonePos) ?? zonePos;
    const currentPos = sprite.getGridPosition();

    this.agentLocation.set(agentId, "walking_to_idle");
    sprite.setState("walking_to_desk");

    const path = this.pathfinder.findPath(currentPos, walkTarget);
    if (path.length > 0) {
      sprite.walkAlongPath(path, () => {
        sprite.snapToGrid(zonePos, pixelOffset);
        sprite.setState("idle");
        this.agentLocation.set(agentId, "idle_zone");
      });
    } else {
      sprite.snapToGrid(zonePos, pixelOffset);
      sprite.setState("idle");
      this.agentLocation.set(agentId, "idle_zone");
    }
  }

  private onIdleRotation(agentId: string): void {
    const location = this.agentLocation.get(agentId);
    // Skip rotation if agent has a desk (is working)
    if (location === "desk" || location === "walking_to_desk") return;

    const sprite = this.agentSprites.get(agentId);
    if (sprite === undefined) return;

    this.walkAgentToIdleZone(agentId, sprite);
  }

  private moveAgentToDesk(agentId: string, sprite: AgentSprite, agent: AgentState): void {
    // Release idle zone
    this.idleZoneManager.releaseZone(agentId);

    // Assign desk
    let deskPos: GridPosition;
    try {
      deskPos = this.deskManager.assignDesk(agentId, agent.tier);
    } catch {
      // No desks available — stay at current position, visual only
      sprite.update(agent);
      return;
    }

    // Chair is one row below the desk in the layout.
    // nearestWalkableNeighbor returns the position itself if walkable,
    // otherwise falls back to the nearest walkable neighbor of the desk.
    const chairPos: GridPosition = { col: deskPos.col, row: deskPos.row + 1 };
    const walkTarget = this.pathfinder.nearestWalkableNeighbor(chairPos)
      ?? this.pathfinder.nearestWalkableNeighbor(deskPos)
        ?? { col: deskPos.col, row: deskPos.row + 1 };
    const currentPos = sprite.getGridPosition();

    this.agentLocation.set(agentId, "walking_to_desk");
    sprite.setState("walking_to_desk");

    const showBubble = (): void => {
      if (getSetting("showPrompts") && agent.currentTask) {
        sprite.showSpeechBubble(agent.currentTask);
      }
    };

    const path = this.pathfinder.findPath(currentPos, walkTarget);
    if (path.length > 0) {
      sprite.walkAlongPath(path, () => {
        sprite.snapToGrid(walkTarget, DESK_SEAT_OFFSET);
        this.agentLocation.set(agentId, "desk");
        sprite.update(agent);
        showBubble();
      });
    } else {
      sprite.snapToGrid(walkTarget, DESK_SEAT_OFFSET);
      this.agentLocation.set(agentId, "desk");
      sprite.update(agent);
      showBubble();
    }
  }

  private moveAgentToIdleZone(agentId: string, sprite: AgentSprite): void {
    // Release desk
    this.deskManager.releaseDesk(agentId);
    this.agentLocation.set(agentId, "walking_to_idle");

    this.walkAgentToIdleZone(agentId, sprite);
  }

  // ---------------------------------------------------------------------------
  // Private: dynamic layout switching
  // ---------------------------------------------------------------------------

  private maybeSwitchLayout(agentCount: number): void {
    const desired = this.desiredLayoutSize(agentCount);
    const current = this.currentLayoutSize();

    if (desired !== current) {
      // In a real implementation, load the appropriate layout JSON.
      // Here we log a warning since only the medium layout is bundled.
      console.info(
        `[OfficeScene] Layout switch requested: ${current} -> ${desired} (agents: ${agentCount})`
      );
    }
  }

  private desiredLayoutSize(agentCount: number): string {
    for (const { maxAgents, size } of LAYOUT_THRESHOLDS) {
      if (agentCount <= maxAgents) return size;
    }
    return "campus";
  }

  private currentLayoutSize(): string {
    if (this.layoutWidth < 12) return "small";
    if (this.layoutWidth <= 24) return "medium";
    if (this.layoutWidth <= 30) return "large";
    return "campus";
  }

}
