export type ObjectiveStatus = 'planned' | 'in-progress' | 'completed';

export interface Objective {
	id: string;
	title: string;
	status: ObjectiveStatus;
}

/** Persistence contract for objectives without prescribing vault storage yet. */
export interface ObjectiveRepository {
	list(): Promise<Objective[]>;
	save(objective: Objective): Promise<void>;
}
