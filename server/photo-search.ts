import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { imageCreditSchema, photoSchema } from "./recipes.js";

const openverseResponseSchema = z.object({
  results: z.array(z.object({
    url: z.string().url(),
    thumbnail: z.string().url().optional(),
    foreign_landing_url: z.string().url(),
    creator: z.string().nullable().optional(),
    license: z.string(),
    license_url: z.string().url(),
  })),
});

function isPublicAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return !(
      normalized === "::" || normalized === "::1" || normalized.startsWith("::ffff:") ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return false;
}

type ResolveAddresses = (hostname: string) => Promise<Array<{ address: string }>>;

async function assertPublicHttpsUrl(value: string, resolve: ResolveAddresses) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || isIP(url.hostname)) {
    throw new Error("The photo source returned an invalid image URL.");
  }
  const addresses = await resolve(url.hostname);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("The photo source returned an inaccessible image URL.");
  }
  return url;
}

async function readLimited(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The photo source returned an empty image.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("The photo source returned an image that is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export async function searchOpenversePhoto(
  query: string,
  dependencies: { fetcher?: typeof fetch; resolve?: ResolveAddresses } = {},
) {
  const fetcher = dependencies.fetcher ?? fetch;
  const resolve = dependencies.resolve ?? (async (hostname) => lookup(hostname, { all: true, verbatim: true }));
  const searchUrl = new URL("https://api.openverse.org/v1/images/");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("license", "cc0");
  searchUrl.searchParams.set("page_size", "1");
  const searchResponse = await fetcher(searchUrl, { signal: AbortSignal.timeout(20_000) });
  if (!searchResponse.ok) throw new Error(`Openverse photo search failed (${searchResponse.status}).`);
  const search = openverseResponseSchema.parse(await searchResponse.json());
  const result = search.results[0];
  if (!result) throw new Error("No public-domain photo matched this recipe. Try another image search.");
  if (result.license.toLowerCase() !== "cc0") {
    throw new Error("The photo search returned an image without a public-domain licence.");
  }

  const imageUrl = await assertPublicHttpsUrl(result.thumbnail ?? result.url, resolve);
  const imageResponse = await fetcher(imageUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!imageResponse.ok) throw new Error(`The photo could not be downloaded (${imageResponse.status}).`);
  const mimeType = imageResponse.headers.get("content-type")?.split(";")[0]?.trim();
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType ?? "")) {
    throw new Error("The photo source returned an unsupported image format.");
  }
  const bytes = await readLimited(imageResponse, 2_100_000);
  const photo = photoSchema.parse({ mimeType, data: bytes.toString("base64") });
  const credit = imageCreditSchema.parse({
    creator: result.creator?.trim() || "Openverse contributor",
    sourceUrl: result.foreign_landing_url,
    license: result.license.toUpperCase(),
    licenseUrl: result.license_url,
  });
  return { image: `data:${photo.mimeType};base64,${photo.data}`, imageCredit: credit };
}
