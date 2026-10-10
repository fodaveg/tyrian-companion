/**
 * Bodies of the public GW2 API as it answered on 10 oct 2026 (`lang=es`, schema 2022-03-23 for the
 * categories), copied for the tests of the «Logros» section. Only tests import this file.
 *
 * - `SEASONS_OF_THE_DRAGONS`: 5790, whose bar counts 24 «Return» meta-achievements, and the five
 *   other achievements of its category 137 (the only thing the API ties to it). The 24 are not
 *   listed anywhere: the 33 «Regreso a …» metas (CategoryDisplay) each live in their own category.
 * - `SAME_NAME_*`: achievements that share a name. «Portero de bar» (8903, 9307) sit in two
 *   categories; «Muerte al Dominio» (5391, 5403) in the same one. Their long tier lists are cut to
 *   the first and last tier.
 */

export const SEASONS_OF_THE_DRAGONS_ID = 5790;

export const SEASONS_OF_THE_DRAGONS_PAGE: unknown = [
	{ id: 5790, name: 'Temporadas de los dragones', description: '', requirement: 'Completa  metalogros de regreso, que estarán disponibles gradualmente y que quedarán disponibles permanentemente cuando se introduzcan.', flags: ['Pvp', 'RepairOnLogin', 'CategoryDisplay', 'Permanent'], tiers: [{ count: 4, points: 25 }, { count: 10, points: 25 }, { count: 16, points: 25 }, { count: 24, points: 25 }], rewards: [{ type: 'Title', id: 369 }] },
	{ id: 5823, name: 'Regreso a la investigación', description: '', requirement: 'Tras completar el episodio 5 de Sangre y Hielo, visita a Taimi y Gorrik en el Ojo del Norte para ver cómo avanza la investigación sobre los dragones.', flags: ['Permanent'], tiers: [{ count: 1, points: 1 }] },
	{ id: 5830, name: 'Estudio de Scarlet', description: '', requirement: 'Tras completar el metalogro "Regreso a los Páramos Argentos 2", visita a Taimi y Gorrik en el Ojo del Norte.', flags: ['Permanent'], tiers: [{ count: 1, points: 1 }], prerequisites: [5823] },
	{ id: 5851, name: 'Confirmación de hipótesis', description: '', requirement: 'Tras completar el metalogro "Regreso a Desembarco de la Sirena", visita a Taimi y Gorrik en el Ojo del Norte.', flags: ['Permanent'], tiers: [{ count: 1, points: 1 }], prerequisites: [5830] },
	{ id: 5960, name: 'Fin a las conjeturas', description: '', requirement: 'Tras completar el metalogro "Regreso a la Tormenta Dracónica", visita a Taimi y Gorrik en el Ojo del Norte.', flags: ['Permanent'], tiers: [{ count: 1, points: 1 }], prerequisites: [5990] },
	{ id: 5990, name: 'Análisis paralelo', description: '', requirement: 'Tras completar el metalogro "Regreso a Dragoncaído", visita a Taimi y Gorrik en el Ojo del Norte.', flags: ['Permanent'], tiers: [{ count: 1, points: 1 }], prerequisites: [5851] },
];

/** `achievements/categories?ids=137` under the 2022 schema: six achievements, the meta among them. */
export const SEASONS_OF_THE_DRAGONS_CATEGORIES: unknown = [
	{ id: 137, name: 'Eventos actuales', description: '', order: 2, icon: 'https://render.guildwars2.com/file/C16C0A32AEB2DCC22B1BB2BCFE0F12F772170DB4/1431767.png', achievements: [{ id: 5790 }, { id: 5823 }, { id: 5830 }, { id: 5851 }, { id: 5960 }, { id: 5990 }] },
];

export const SAME_NAME_PAGE: unknown = [
	{ id: 8903, icon: 'https://render.guildwars2.com/file/98B1985F1A07664CE00F624B6A7BC775126408A5/3713020.png', name: 'Portero de bar', description: 'Tenemos nueva gerencia.', requirement: 'Calma a los clientes alborotadores de la Taberna Canach.', flags: ['Permanent'], tiers: [{ count: 1, points: 1 }, { count: 10, points: 1 }] },
	{ id: 9307, name: 'Portero de bar', description: 'No mientras yo vigile.', requirement: 'Impide que el jefe final del Templo de la Abnegación silencie a la iluminada Fiadh.', flags: ['Hidden', 'Permanent'], tiers: [{ count: 1, points: 0 }] },
	{ id: 5403, name: 'Muerte al Dominio', description: '', requirement: 'Consigue menciones charr para las legiones derrotando a las fuerzas del Dominio y cumpliendo objetivos en la Costa de Bosquellovizna.', flags: ['Pvp', 'Permanent'], tiers: [{ count: 250, points: 1 }, { count: 5000, points: 2 }] },
	{ id: 5391, name: 'Muerte al Dominio', description: '', requirement: 'Consigue menciones charr para las legiones derrotando a las fuerzas del Dominio y cumpliendo objetivos en la Costa de Bosquellovizna.', flags: ['IgnoreNearlyComplete', 'Pvp', 'Repeatable', 'Permanent'], tiers: [{ count: 250, points: 0 }, { count: 5000, points: 0 }], prerequisites: [5403], point_cap: -1 },
];

/** The three categories that list them (254 lists both «Muerte al Dominio»). */
export const SAME_NAME_CATEGORIES: unknown = [
	{ id: 254, name: 'Jormag desatado', order: 1, achievements: [{ id: 5391 }, { id: 5403 }] },
	{ id: 463, name: 'Litoral del Naufragio', order: 2, achievements: [{ id: 8903 }] },
	{ id: 482, name: 'Jardín de la Eternidad', order: 3, achievements: [{ id: 9307 }] },
];
