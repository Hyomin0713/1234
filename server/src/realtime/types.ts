export type Job = "warrior" | "thief" | "archer" | "mage";

export interface Buffs {
  simbi: number;
  ppungbi: number;
  shopbi: number;
}

export interface QueueUser {
  id: string;              // Discord user id or your internal id
  job: Job;
  blacklist: string[];     // list of user ids
  partyId?: string;
  lastSeenAt: number;      // ms epoch
}

export type PartyStatus = "open" | "matching" | "matched" | "expired";

export interface Party {
  id: string;
  leaderId: string;
  members: string[];       // userIds
  maxMembers: 6;
  buffs: Buffs;

  isOpen: boolean;         // can random-match join?
  status: PartyStatus;

  channelId?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface PartyStatePayload {
  partyId: string;
  leaderId: string;
  members: Array<Pick<QueueUser, "id" | "job">>;
  buffs: Buffs;
  status: PartyStatus;
  isOpen: boolean;
  channelId?: string;
  expiresAt: number;
}

export interface MatchAssignedPayload {
  partyId: string;
  channelId?: string;
  status: PartyStatus;
}
