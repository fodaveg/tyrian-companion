export async function sha256Text(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value.replace(/\r\n?/gu, '\n'));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}
