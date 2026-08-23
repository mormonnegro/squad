import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import forge from "node-forge";

export interface IssuedCertificate {
	readonly certPem: string;
	readonly keyPem: string;
}

export interface CertificateAuthority {
	/** PEM of the root certificate. Must be installed in each sandbox's trust store. */
	readonly caCertPem: string;
	issue(host: string): IssuedCertificate;
}

const CA_ATTRS: forge.pki.CertificateField[] = [
	{ name: "commonName", value: "agent-dive local egress CA" },
	{ name: "organizationName", value: "agent-dive" },
];

function randomSerial(): string {
	// Leading "00" keeps the DER integer positive, which some TLS stacks require.
	return `00${forge.util.bytesToHex(forge.random.getBytesSync(16))}`;
}

type CertificateExtension = Parameters<forge.pki.Certificate["setExtensions"]>[0][number];

function subjectAltName(host: string): CertificateExtension {
	const type = isIP(host) !== 0 ? 7 : 2;
	return {
		name: "subjectAltName",
		altNames: [type === 7 ? { type, ip: host } : { type, value: host }],
	};
}

class ForgeCertificateAuthority implements CertificateAuthority {
	readonly caCertPem: string;
	private readonly caCert: forge.pki.Certificate;
	private readonly caKey: forge.pki.rsa.PrivateKey;
	private readonly leafKeys: forge.pki.rsa.KeyPair;
	private readonly leafKeyPem: string;
	private readonly cache = new Map<string, IssuedCertificate>();

	constructor(caCertPem: string, caKeyPem: string) {
		this.caCertPem = caCertPem;
		this.caCert = forge.pki.certificateFromPem(caCertPem);
		this.caKey = forge.pki.privateKeyFromPem(caKeyPem) as forge.pki.rsa.PrivateKey;
		// One leaf key reused across hosts: only the certificate has to be re-signed per host,
		// which turns a ~300ms RSA keygen per connection into a ~2ms signature.
		this.leafKeys = forge.pki.rsa.generateKeyPair(2048);
		this.leafKeyPem = forge.pki.privateKeyToPem(this.leafKeys.privateKey);
	}

	issue(host: string): IssuedCertificate {
		const cached = this.cache.get(host);
		if (cached) return cached;

		const cert = forge.pki.createCertificate();
		cert.publicKey = this.leafKeys.publicKey;
		cert.serialNumber = randomSerial();
		cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
		cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
		cert.setSubject([{ name: "commonName", value: host }]);
		cert.setIssuer(this.caCert.subject.attributes);
		cert.setExtensions([
			{ name: "basicConstraints", cA: false },
			{ name: "keyUsage", digitalSignature: true, keyEncipherment: true },
			{ name: "extKeyUsage", serverAuth: true },
			subjectAltName(host),
		]);
		cert.sign(this.caKey, forge.md.sha256.create());

		const issued: IssuedCertificate = {
			certPem: forge.pki.certificateToPem(cert),
			keyPem: this.leafKeyPem,
		};
		this.cache.set(host, issued);
		return issued;
	}
}

function mintRootCa(): { certPem: string; keyPem: string } {
	const keys = forge.pki.rsa.generateKeyPair(2048);
	const cert = forge.pki.createCertificate();
	cert.publicKey = keys.publicKey;
	cert.serialNumber = randomSerial();
	cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
	cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
	cert.setSubject(CA_ATTRS);
	cert.setIssuer(CA_ATTRS);
	cert.setExtensions([
		{ name: "basicConstraints", cA: true, critical: true },
		{ name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
	]);
	cert.sign(keys.privateKey, forge.md.sha256.create());

	return {
		certPem: forge.pki.certificateToPem(cert),
		keyPem: forge.pki.privateKeyToPem(keys.privateKey),
	};
}

export function createCertificateAuthority(): CertificateAuthority {
	const { certPem, keyPem } = mintRootCa();
	return new ForgeCertificateAuthority(certPem, keyPem);
}

/** Persists the CA so sandbox images built against a previous run keep trusting the proxy. */
export function loadOrCreateCertificateAuthority(directory: string): CertificateAuthority {
	const certPath = join(directory, "ca.crt");
	const keyPath = join(directory, "ca.key");

	if (existsSync(certPath) && existsSync(keyPath)) {
		return new ForgeCertificateAuthority(
			readFileSync(certPath, "utf8"),
			readFileSync(keyPath, "utf8"),
		);
	}

	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const { certPem, keyPem } = mintRootCa();
	writeFileSync(certPath, certPem, { mode: 0o644 });
	writeFileSync(keyPath, keyPem, { mode: 0o600 });

	return new ForgeCertificateAuthority(certPem, keyPem);
}
