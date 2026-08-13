import type { SessionCommandController } from './session-command-controller';
import type { SessionCommandDescriptor, SessionCommandId } from './session-command-model';

export interface PaletteCommandSpec {
	id: SessionCommandId;
	name: string;
	checkCallback(checking: boolean): boolean;
}

export interface PaletteCommandRegistry {
	addCommand(spec: PaletteCommandSpec): void;
}

export type SessionMenuDescriptor =
	| { type: 'open'; title: 'Open companion'; icon: 'compass' }
	| { type: 'separator' }
	| { type: 'command'; command: SessionCommandDescriptor };

export interface SessionCommandDispatch {
	finish(): Promise<void>;
	recover(): Promise<void>;
	discard(): Promise<void>;
}

export function hasExactSessionBackendResult(
	action: 'recover' | 'discard' | 'clear',
	result: unknown,
): boolean {
	if (action === 'clear') return result === true;
	return typeof result === 'object' && result !== null
		&& 'status' in result
		&& result.status === (action === 'recover' ? 'recovered' : 'discarded');
}

export function createSessionCommandDispatch(
	controller: Pick<SessionCommandController, 'run'>,
): SessionCommandDispatch {
	return {
		finish: () => controller.run('finish-farming-session'),
		recover: () => controller.run('recover-saved-session'),
		discard: () => controller.run('discard-saved-session'),
	};
}

export function registerSessionPalette(
	registry: PaletteCommandRegistry,
	controller: Pick<SessionCommandController, 'describe' | 'run'>,
	ids: readonly SessionCommandId[],
): void {
	for (const id of ids) {
		registry.addCommand({
			id,
			name: controller.describe(id).name,
			checkCallback: (checking) => {
				const available = controller.describe(id).available;
				if (!checking && available) void controller.run(id);
				return available;
			},
		});
	}
}

export function projectSessionMenu(commands: readonly SessionCommandDescriptor[]): SessionMenuDescriptor[] {
	const primary = commands.filter((command) => !command.destructive);
	const destructive = commands.filter((command) => command.destructive);
	const menu: SessionMenuDescriptor[] = [{ type: 'open', title: 'Open companion', icon: 'compass' }];
	if (primary.length > 0) menu.push({ type: 'separator' });
	menu.push(...primary.map((command) => ({ type: 'command', command }) as const));
	if (destructive.length > 0) menu.push({ type: 'separator' });
	menu.push(...destructive.map((command) => ({ type: 'command', command }) as const));
	return menu;
}
