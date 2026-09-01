import {
	createContainerModel,
	expectedUnitsMillionths,
	type ContainerModelV1,
	type OutcomeValuationPolicy,
} from '../container-model';

const CONTAINERS_OPENED = 106_264;
const OBSERVED_UNITS = 892_130;
export const HALLOWEEN_TRICK_OR_TREAT_MODEL_ID = 'halloween-trick-or-treat-bag-conservative';

interface SourceOutcome {
	id: number;
	label: string;
	sampleUnits: number;
	valuationPolicy: OutcomeValuationPolicy;
}

// Community totals from GW2 Wiki revision 3161313. Super-rare outcomes and the
// long tail of rare drops are deliberately excluded from this conservative v1.
const SOURCE_OUTCOMES: SourceOutcome[] = [
	{ id: 36_031, label: 'Toilet Paper', sampleUnits: 6_090, valuationPolicy: 'excluded' },
	{ id: 36_032, label: 'Rotten Egg', sampleUnits: 6_260, valuationPolicy: 'excluded' },
	{ id: 36_041, label: 'Piece of Candy Corn', sampleUnits: 386_935, valuationPolicy: 'liquid_market' },
	{ id: 36_059, label: 'Plastic Fangs', sampleUnits: 119_732, valuationPolicy: 'liquid_market' },
	{ id: 36_060, label: 'Chattering Skull', sampleUnits: 117_219, valuationPolicy: 'liquid_market' },
	{ id: 36_061, label: 'Nougat Center', sampleUnits: 117_615, valuationPolicy: 'liquid_market' },
	{ id: 36_408, label: 'Limited-Use Scarecrow Finisher', sampleUnits: 2_006, valuationPolicy: 'excluded' },
	{ id: 36_409, label: 'Limited-Use Mad King Finisher', sampleUnits: 1_983, valuationPolicy: 'excluded' },
	{ id: 45_176, label: 'Masterwork Essence of Luck', sampleUnits: 20_780, valuationPolicy: 'excluded' },
	{ id: 45_177, label: 'Rare Essence of Luck', sampleUnits: 6_181, valuationPolicy: 'excluded' },
	{ id: 45_178, label: 'Exotic Essence of Luck', sampleUnits: 4_105, valuationPolicy: 'excluded' },
	{ id: 46_731, label: 'Pile of Bloodstone Dust', sampleUnits: 25_976, valuationPolicy: 'excluded' },
	{ id: 46_733, label: 'Dragonite Ore', sampleUnits: 28_489, valuationPolicy: 'excluded' },
	{ id: 46_735, label: 'Empyreal Fragment', sampleUnits: 26_581, valuationPolicy: 'excluded' },
	{ id: 79_673, label: 'Gargoyle Tonic', sampleUnits: 5_516, valuationPolicy: 'liquid_market' },
	{ id: 79_677, label: 'Shadow Raven Tonic', sampleUnits: 5_648, valuationPolicy: 'liquid_market' },
	{ id: 79_679, label: 'Hellfire Skeleton Tonic', sampleUnits: 5_570, valuationPolicy: 'liquid_market' },
	{ id: 89_002, label: 'Soul Pastry', sampleUnits: 4_273, valuationPolicy: 'liquid_market' },
];

// The named part of the super-rare bucket, from the same revision. Ascending by id.
const SUPER_RARE_JACKPOTS = [
	{ id: 79_674, label: 'Phospholuminescent Infusion', sampleUnits: 1 },
	{ id: 89_007, label: 'Polysaturating Reverberating Infusion (Gray)', sampleUnits: 4 },
	{ id: 89_065, label: 'Ember Infusion', sampleUnits: 2 },
	{ id: 89_070, label: 'Polysaturating Reverberating Infusion (Purple)', sampleUnits: 3 },
	{ id: 89_071, label: 'Polysaturating Reverberating Infusion (Red)', sampleUnits: 3 },
];

const candidate: ContainerModelV1 = {
	schemaVersion: 1,
	modelId: HALLOWEEN_TRICK_OR_TREAT_MODEL_ID,
	modelVersion: 1,
	containerItemId: 36_038,
	title: 'Trick-or-Treat Bag — conservative community model',
	source: {
		name: 'Guild Wars 2 Wiki community drop-rate research, revision 3161313',
		url: 'https://wiki.guildwars2.com/index.php?title=Trick-or-Treat_Bag/research&oldid=3161313',
		publishedAt: '2026-06-17T23:47:25.000Z',
		retrievedAt: '2026-08-13T00:00:00.000Z',
	},
	sample: {
		containersOpened: CONTAINERS_OPENED,
		observations: OBSERVED_UNITS,
		observedFrom: '2024-03-13T18:35:00.000Z',
		observedUntil: '2026-06-17T23:47:25.000Z',
	},
	outcomes: SOURCE_OUTCOMES.map((outcome) => ({
		key: `item:${String(outcome.id)}`,
		namespace: 'item' as const,
		...outcome,
		expectedUnitsMillionths: expectedUnitsMillionths(outcome.sampleUnits, CONTAINERS_OPENED)!,
	})),
	excluded: [
		{ category: 'Rare long tail except Soul Pastry', sampleUnits: 1_121, reason: 'unsupported_long_tail', items: [] },
		// 13 of the 50 super-rare units are named by the same wiki revision. They stay
		// OUT of the conservative expected value; itemizing them only lets the tail be
		// priced and shown apart, because five infusions at hundreds of gold each are
		// the difference between a lottery ticket and a loss for whoever opens at scale.
		{ category: 'Super rare jackpots', sampleUnits: 50, reason: 'super_rare_jackpot', items: SUPER_RARE_JACKPOTS },
	],
	uncertainty: {
		method: 'sample_only',
		confidenceBasisPoints: null,
		rareDropTreatment: 'excluded',
		notes: [
			'Community research is experimental and is not an official ArenaNet drop table.',
			'All super-rare outcomes are excluded from expected value.',
			'Rare outcomes other than Soul Pastry are excluded from expected value.',
			'This snapshot represents wiki revision 3161313 and must be reviewed after loot-table changes.',
		],
	},
	createdAt: '2026-08-13T00:00:00.000Z',
};

const validated = createContainerModel(candidate);
if (validated.status !== 'ok') throw new Error('Invalid built-in Trick-or-Treat Bag model.');

const HISTORICAL_MODEL_V1 = validated.model;
const HISTORICAL_MODELS = new Map<string, ContainerModelV1>([
	[modelKey(HISTORICAL_MODEL_V1.modelId, HISTORICAL_MODEL_V1.modelVersion), HISTORICAL_MODEL_V1],
]);
const LATEST_MODEL_VERSION = 1;

export function halloweenTrickOrTreatBagModel(): ContainerModelV1 {
	const model = halloweenTrickOrTreatBagModelAt(HALLOWEEN_TRICK_OR_TREAT_MODEL_ID, LATEST_MODEL_VERSION);
	if (model === null) throw new Error('Missing latest Trick-or-Treat Bag model.');
	return model;
}

/** Resolves an immutable historical snapshot instead of interpreting old evidence with the latest model. */
export function halloweenTrickOrTreatBagModelAt(modelId: string, modelVersion: number): ContainerModelV1 | null {
	const model = HISTORICAL_MODELS.get(modelKey(modelId, modelVersion));
	return model === undefined ? null : structuredClone(model);
}

function modelKey(modelId: string, modelVersion: number): string { return `${modelId}\u0000${String(modelVersion)}`; }
