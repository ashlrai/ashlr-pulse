/**
 * fleet-inbox-db.ts — the human operator's view over the fleet_command queue.
 *
 * The /fleet page is where an operator watches the cloud→local command queue
 * drain: pending / claimed / done / failed, newest first, with status-count
 * badges in the header. It is the read/cancel side of the same table the
 * daemon polls (fleet-commands-db's listPending / claimNext).
 *
 * The actual queries live in fleet-commands-db.ts alongside the shared
 * row→FleetCommand mapping (mapRow) and column projection (rowColumns) so the
 * inbox and the daemon poll share exactly one mapping with no drift. This
 * module re-exports the inbox-facing surface under the name the page imports,
 * keeping the page's dependency narrow and intent-revealing.
 */

export {
  listForOrg,
  countsByStatus,
  cancelPending,
  getCommand,
  type StatusCounts,
} from "./fleet-commands-db";

export type { FleetCommand, FleetCommandStatus, FleetCommandKind } from "./graph-types";
