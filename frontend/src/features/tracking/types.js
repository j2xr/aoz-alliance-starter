/**
 * @typedef {Object} Alliance
 * @property {string} id
 * @property {string} name
 * @property {string|null} tag
 * @property {string} created_at
 */

/**
 * @typedef {Object} UserAlliance
 * @property {string} id
 * @property {string} name
 * @property {'admin'|'viewer'} role
 */

/**
 * @typedef {Object} EventType
 * @property {string} code
 * @property {string} display_name
 */

/**
 * @typedef {Object} AtEvent
 * @property {string} id
 * @property {string} alliance_id
 * @property {string} event_datetime
 * @property {number|null} alliance_rank
 * @property {number|null} total_battlers
 * @property {number|null} total_points
 * @property {EventType|null} at_event_types
 */

/**
 * @typedef {Object} LeaderboardRow
 * @property {string} event_id
 * @property {number} position
 * @property {string} player_name
 * @property {string|null} rank
 * @property {number|null} power
 * @property {number|null} points
 */

/**
 * @typedef {Object} ParticipationRow
 * @property {string} alliance_id
 * @property {string} player_id
 * @property {string} player_name
 * @property {number} events_participated
 * @property {number} eligible_events
 * @property {number|null} participation_rate_pct
 * @property {number|null} avg_points
 * @property {string|null} last_participation
 */

/**
 * @typedef {Object} PlayerStat
 * @property {string} event_datetime
 * @property {number|null} points
 * @property {number|null} power
 * @property {string} event_type_code
 */

/**
 * @typedef {Object} DonationPeriod
 * @property {string} id
 * @property {'weekly'} period_type
 * @property {string} period_start ISO date (YYYY-MM-DD), Monday Europe/Paris
 * @property {string} period_end   ISO date (YYYY-MM-DD)
 */

/**
 * @typedef {Object} DonationLeaderboardRow
 * @property {string} donation_period_id
 * @property {string} alliance_id
 * @property {'weekly'} period_type
 * @property {string} period_start
 * @property {string} period_end
 * @property {string} alliance_name
 * @property {string|null} player_id
 * @property {string|null} player_name
 * @property {string|null} player_rank
 * @property {number} alliance_honor
 * @property {string|null} updated_at
 * @property {number} position
 */

/**
 * @typedef {Object} DonationPlayerTotals
 * @property {string} alliance_id
 * @property {string} player_id
 * @property {string} name
 * @property {number} periods_contributed
 * @property {number} total_alliance_honor
 * @property {number} best_period_honor
 * @property {number} avg_per_period
 * @property {string|null} last_period_start
 */

/**
 * @typedef {Object} PlayerDonationHistoryRow
 * @property {string} id
 * @property {number} alliance_honor
 * @property {string} updated_at
 * @property {string|null} period_id
 * @property {string|null} period_start
 * @property {string|null} period_end
 */
