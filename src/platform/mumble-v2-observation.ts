import type { MumbleV2DerivedActivity, MumbleV2IpcFrameV1 } from './mumble-v2-contract';

export interface MumbleV2ShadowProjection {
	mapId: number;
	activity: MumbleV2DerivedActivity;
}

/** Memory-only shadow projection with no outbound ports. */
export class MumbleV2ShadowObservation {
	private enabled = false;
	private armed = false;
	private projection: MumbleV2ShadowProjection | null = null;

	configure(configuration: { enabled: boolean; armed: boolean }): void {
		this.enabled = configuration.enabled;
		this.armed = configuration.armed;
		if (!this.enabled || !this.armed) this.projection = null;
	}

	observe(frame: MumbleV2IpcFrameV1): MumbleV2ShadowProjection | null {
		if (!this.enabled || !this.armed) return null;
		this.projection = { mapId: frame.mapId, activity: frame.activity };
		return { ...this.projection };
	}

	getSnapshot(): MumbleV2ShadowProjection | null {
		return this.projection === null ? null : { ...this.projection };
	}
}
