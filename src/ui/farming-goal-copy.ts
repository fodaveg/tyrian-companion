/** Local ES/EN copy for host-neutral farming components; no host API is needed. */
const EN = {
	goal: 'Goal for this session', none: 'No goal', bags: 'Observed bags', duration: 'Measured duration',
	target: 'Target', minutes: 'Minutes', save: 'Save', saved: 'Saved for the next session', saving: 'Saving…',
	invalid: 'Enter a positive whole number within the allowed range.', failed: 'Could not save. Your previous setting is kept.',
	observed: 'Observed bags', net: 'Net bags kept at close', unknownTotal: 'Total obtained cannot be observed between polls.',
	countdown: 'Time remaining', estimate: 'Approximate time remaining', unavailable: 'Estimate not available yet',
	reached: 'Observed goal reached', in_progress: 'In progress', unavailableStatus: 'Observation unavailable',
	durationReached: 'Duration goal reached', age: 'Observation age', no_observation: 'No usable observation',
	insufficient_sample: 'Waiting for a sufficient sample', stale_observation: 'Observation is old',
	invalid_observation: 'Observation unavailable', no_rate: 'No observed rate yet',
	preparation: 'Optional preparation', enabled: 'Show preparation', character: 'Character', build: 'Build',
	slots: 'Free character bag slots', collector: 'Device mode', addon: 'Addon connection',
	collectorMode: 'Collector', consultMode: 'Consult', connected: 'Connected', disconnected: 'Disconnected',
	unknown: 'Unknown', magicFind: 'Magic Find · Partial', observable: 'API-observable components',
	manual: 'Manual bonus', mfLimit: 'Observable data + manual bonuses. Temporary buffs are unverified.',
	food: 'Food', utility: 'Utility', reminder: 'Manual reminder', reminderMinutes: 'Manual reminder interval (minutes)',
	startReminder: 'Start reminder', clearReminder: 'Clear reminder', due: 'Reminder due',
	reminderLimit: 'Manual reminder; this does not detect an active buff.',
	reviewed: 'I have checked food and utility', noBuildName: 'Unnamed build',
} as const;
const ES: Record<keyof typeof EN, string> = {
	goal: 'Objetivo de esta tanda', none: 'Sin objetivo', bags: 'Bolsas observadas', duration: 'Duración medida',
	target: 'Objetivo', minutes: 'Minutos', save: 'Guardar', saved: 'Guardado para la próxima sesión', saving: 'Guardando…',
	invalid: 'Introduce un número entero positivo dentro del intervalo permitido.', failed: 'No se pudo guardar. Se conserva el ajuste anterior.',
	observed: 'Bolsas observadas', net: 'Bolsas netas conservadas al cierre', unknownTotal: 'El total obtenido entre sondeos no es observable.',
	countdown: 'Tiempo restante', estimate: 'Tiempo restante aproximado', unavailable: 'Estimación aún no disponible',
	reached: 'Objetivo observado alcanzado', in_progress: 'En curso', unavailableStatus: 'Observación no disponible',
	durationReached: 'Objetivo de duración alcanzado', age: 'Antigüedad de la observación', no_observation: 'Sin observación utilizable',
	insufficient_sample: 'Esperando una muestra suficiente', stale_observation: 'Observación antigua',
	invalid_observation: 'Observación no disponible', no_rate: 'Sin ritmo observado todavía',
	preparation: 'Preparación opcional', enabled: 'Mostrar preparación', character: 'Personaje', build: 'Build',
	slots: 'Huecos libres en las bolsas del personaje', collector: 'Modo del dispositivo', addon: 'Conexión del addon',
	collectorMode: 'Recolector', consultMode: 'Consulta', connected: 'Conectado', disconnected: 'Desconectado',
	unknown: 'Desconocido', magicFind: 'Hallazgo mágico · Parcial', observable: 'Componentes consultables por API',
	manual: 'Bonus manual', mfLimit: 'Datos consultables + bonus manuales. Buffs temporales sin verificar.',
	food: 'Comida', utility: 'Utilidad', reminder: 'Recordatorio manual', reminderMinutes: 'Intervalo del recordatorio manual (minutos)',
	startReminder: 'Iniciar recordatorio', clearReminder: 'Quitar recordatorio', due: 'Recordatorio vencido',
	reminderLimit: 'Recordatorio manual; no detecta un buff activo.',
	reviewed: 'He revisado comida y utilidad', noBuildName: 'Build sin nombre',
};
export type FarmingCopyKey = keyof typeof EN;
export function farmingCopy(locale: 'es' | 'en', key: FarmingCopyKey): string {
	return locale === 'es' ? ES[key] : EN[key];
}

/** Formats elapsed/remaining time as a duration, never an ISO timestamp on screen. */
export function formatFarmingTime(milliseconds: number): string {
	const seconds = Math.ceil(Math.max(0, milliseconds) / 1_000);
	const hours = Math.floor(seconds / 3_600);
	const minutes = Math.floor(seconds % 3_600 / 60);
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
		: `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
