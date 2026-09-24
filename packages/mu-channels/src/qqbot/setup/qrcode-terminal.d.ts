declare module "qrcode-terminal" {
	interface QRCodeTerminal {
		generate(input: string, options: { small?: boolean }, callback: (qrcode: string) => void): void;
	}
	const qrcode: QRCodeTerminal;
	export default qrcode;
}
