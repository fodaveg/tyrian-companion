/** Live comparison copy shares the existing component-local EN/ES convention. */
const EN = {
	title: 'Compare Nexus sessions', load: 'Load comparisons', loading: 'Loading saved observations…', idle: 'Load saved Nexus sessions to compare them.',
	unavailable: 'Could not load comparisons. Saved evidence is kept; try again.', conflict: 'Saved evidence conflicts or is invalid. Resolve the notes before comparing.',
	limit: 'Observed increases have an unknown cause. These comparisons show association, not the effect of a build or group.',
	buildTemplate: 'Captured GW2 template', buildManual: 'manual template · activity/equipment unverified', buildUnknown: 'Player build unknown', conditions: 'Captured conditions', groupUnknown: 'Group undeclared', with_bosses: 'With bosses (declared)', without_bosses: 'Without bosses (declared)',
	pure_labyrinth: 'Labyrinth only', mixed: 'Mixed maps', unknown: 'Map coverage unknown', magicFind: 'Magic Find', manualBonus: 'Declared bonus',
	manual: 'manual', verified: 'observed', sourceUnknown: 'unknown', finalCount: 'Completed sessions', eligible: 'Bag samples', minimum: 'At least two completed samples with covered item time are required.',
	connection: 'Session duration', coverage: 'Covered item time', positive: 'Observed bag increases', negative: 'Observed bag decreases', net: 'Observed bag net',
	rate: 'Bags/h of covered item time', range: 'Individual sample range', gold: 'Complete gold/h unavailable for this inventory source.',
	provisional: 'Current session · provisional, excluded from completed samples', knownValue: 'Estimated known item net · captured prices', partialPrices: 'Unpriced item records', gaps: 'Recorded gaps',
	previous: 'Previous', next: 'Next', empty: 'No completed Nexus sessions.',
} as const;
const ES: Record<keyof typeof EN, string> = {
	title: 'Comparar tandas Nexus', load: 'Cargar comparaciones', loading: 'Cargando observaciones guardadas…', idle: 'Carga las tandas Nexus guardadas para compararlas.',
	unavailable: 'No se pudieron cargar las comparaciones. La evidencia se conserva; vuelve a intentarlo.', conflict: 'La evidencia guardada tiene conflictos o datos inválidos. Resuelve las notas antes de comparar.',
	limit: 'Los aumentos observados tienen causa desconocida. Estas comparaciones muestran asociación, no el efecto de una build o un grupo.',
	buildTemplate: 'Plantilla GW2 capturada', buildManual: 'plantilla manual · activa/equipo sin verificar', buildUnknown: 'Build del jugador desconocida', conditions: 'Condiciones capturadas', groupUnknown: 'Grupo sin declarar', with_bosses: 'Con jefes (declarado)', without_bosses: 'Sin jefes (declarado)',
	pure_labyrinth: 'Solo laberinto', mixed: 'Mapas mixtos', unknown: 'Cobertura de mapa desconocida', magicFind: 'Hallazgo mágico', manualBonus: 'Bonus declarado',
	manual: 'manual', verified: 'observado', sourceUnknown: 'desconocido', finalCount: 'Tandas completadas', eligible: 'Muestras de bolsas', minimum: 'Se necesitan al menos dos muestras completadas con tiempo de items cubierto.',
	connection: 'Duración de tanda', coverage: 'Tiempo de items cubierto', positive: 'Aumentos de bolsas observados', negative: 'Disminuciones de bolsas observadas', net: 'Neto de bolsas observado',
	rate: 'Bolsas/h de tiempo de items cubierto', range: 'Rango de muestras individuales', gold: 'Oro/h completo no disponible para esta fuente de inventario.',
	provisional: 'Tanda actual · provisional, fuera de la muestra completada', knownValue: 'Neto conocido de items estimado · precios capturados', partialPrices: 'Registros de items sin precio', gaps: 'Huecos guardados',
	previous: 'Anterior', next: 'Siguiente', empty: 'Sin tandas Nexus completadas.',
};
export type LiveComparisonCopyKey = keyof typeof EN;
export function liveComparisonCopy(locale: 'es' | 'en', key: LiveComparisonCopyKey): string { return (locale === 'es' ? ES : EN)[key]; }
