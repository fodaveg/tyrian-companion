import type { CatalogLocale } from '../catalog/public-catalog-model';
import type { LeyspringCaptureFailureReason, LeyspringCaptureService } from './leyspring-capture';
import type { LeyspringNoteResult, LeyspringNoteWriter } from './leyspring-note';

export type LeyspringRunResult =
	| LeyspringNoteResult
	/** The reading failed: the note keeps what it said, nothing is unticked. */
	| { status: 'unavailable'; reason: LeyspringCaptureFailureReason }
	/** A previous run is still in flight. */
	| { status: 'busy' };

/**
 * "Actualizar logros de Leyspring": one reading, one note. The player launches it; nothing runs it
 * on its own. A failed reading never reaches the writer, so the last note stays as it was.
 */
export class LeyspringAchievementsService {
	private running = false;

	constructor(
		private readonly capture: Pick<LeyspringCaptureService, 'capture'>,
		private readonly writer: Pick<LeyspringNoteWriter, 'write'>,
	) {}

	async run(root: string, locale: CatalogLocale): Promise<LeyspringRunResult> {
		if (this.running) return { status: 'busy' };
		this.running = true;
		try {
			const reading = await this.capture.capture(locale);
			if (reading.status !== 'ok') return reading;
			return await this.writer.write(root, reading.capture);
		} finally {
			this.running = false;
		}
	}
}
