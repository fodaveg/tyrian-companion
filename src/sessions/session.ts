export type SessionStatus = 'planned' | 'active' | 'completed';

export interface PlaySession {
	id: string;
	startedAt: string;
	endedAt: string | null;
	status: SessionStatus;
}

/** Persistence contract for future session tracking. */
export interface SessionRepository {
	list(): Promise<PlaySession[]>;
	save(session: PlaySession): Promise<void>;
}
