import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { PDFParse } from "pdf-parse";
import type { DocumentRecord, SourceInput, SourceRecord } from "@comms-agent/shared";
import { sha256, stableId, stripHtml, titleFromHtml, normalizeWhitespace } from "@comms-agent/core";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".html",
  ".yml",
  ".yaml"
]);

export async function loadDocuments(source: SourceRecord): Promise<DocumentRecord[]> {
  if (source.kind === "text") {
    return [
      makeDocument(source, {
        title: source.title ?? "Pasted knowledge",
        text: source.content ?? "",
        uri: source.uri
      })
    ];
  }

  if (source.kind === "url") {
    if (!source.uri) {
      throw new Error("URL source requires a uri");
    }
    const response = await fetch(source.uri);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${source.uri}: ${response.status} ${response.statusText}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/pdf") || source.uri.toLowerCase().endsWith(".pdf")) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const text = await readPdf(buffer);
      return [
        makeDocument(source, {
          title: source.title ?? (basename(new URL(source.uri).pathname) || "PDF document"),
          text,
          uri: source.uri,
          metadata: {
            extractor: "pdf-parse",
            contentType
          }
        })
      ];
    }
    const html = await response.text();
    const readable = extractReadableHtml(html, source.uri);
    return [
      makeDocument(source, {
        title: readable.title,
        text: readable.text,
        uri: source.uri,
        metadata: {
          extractor: readable.extractor,
          contentType
        }
      })
    ];
  }

  if (source.kind === "file" || source.kind === "directory") {
    if (!source.uri) {
      throw new Error(`${source.kind} source requires a local path uri`);
    }
    const fileStat = await stat(source.uri);
    if (source.kind === "directory" || fileStat.isDirectory()) {
      return loadDirectoryDocuments(source, source.uri);
    }
    const text = await readLocalFile(source.uri);
    return [
      makeDocument(source, {
        title: source.title ?? basename(source.uri),
        text,
        uri: source.uri,
        metadata: {
          extractor: extractorForPath(source.uri)
        }
      })
    ];
  }

  if (source.kind === "github_repo") {
    if (!source.uri) {
      throw new Error("GitHub repository source requires a uri");
    }
    return loadGithubRepository(source);
  }

  const _exhaustive: never = source.kind;
  throw new Error(`Unsupported source kind ${_exhaustive}`);
}

export function normalizeSourceInput(input: SourceInput): SourceInput {
  return {
    ...input,
    title: input.title?.trim() || undefined,
    uri: input.uri?.trim() || undefined,
    content: input.content?.trim() || undefined,
    tags: input.tags?.map((tag) => tag.trim()).filter(Boolean) ?? []
  };
}

async function loadDirectoryDocuments(source: SourceRecord, directory: string): Promise<DocumentRecord[]> {
  const files = await walk(directory);
  const documents: DocumentRecord[] = [];
  for (const file of files.slice(0, 40)) {
    const text = await readLocalFile(file);
    if (!text.trim()) {
      continue;
    }
    documents.push(
      makeDocument(source, {
        title: basename(file),
        text,
        uri: file,
        metadata: {
          extractor: extractorForPath(file),
          directory
        }
      })
    );
  }
  return documents;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (TEXT_EXTENSIONS.has(extension) || extension === ".pdf") {
      files.push(path);
    }
  }
  return files;
}

async function readLocalFile(filePath: string): Promise<string> {
  const extension = extname(filePath).toLowerCase();
  const buffer = await readFile(filePath);
  if (extension === ".pdf") {
    return readPdf(buffer);
  }
  if (extension === ".html") {
    return extractReadableHtml(buffer.toString("utf8"), filePath).text;
  }
  return normalizeWhitespace(buffer.toString("utf8"));
}

async function readPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return normalizeWhitespace(result.text);
  } finally {
    await parser.destroy();
  }
}

function extractReadableHtml(html: string, uri: string): { title: string; text: string; extractor: string } {
  const dom = new JSDOM(html, { url: safeDomUrl(uri) });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  const strippedText = stripHtml(html);
  if (article?.textContent && article.textContent.trim().length >= 80) {
    const readableText = normalizeWhitespace(article.textContent);
    const preserveStructuredText = structuredTextScore(strippedText) > structuredTextScore(readableText);
    return {
      title: normalizeWhitespace(article.title || titleFromHtml(html, uri)),
      text: preserveStructuredText ? strippedText : readableText,
      extractor: preserveStructuredText ? "html-strip-structured" : "readability"
    };
  }
  return {
    title: titleFromHtml(html, uri),
    text: strippedText,
    extractor: "html-strip-fallback"
  };
}

function structuredTextScore(text: string): number {
  return (
    (text.match(/\s\|\s/g)?.length ?? 0) +
    (text.match(/\b(?:1[5-9]|20)\d{2}\s+\|/g)?.length ?? 0) * 3
  );
}

async function loadGithubRepository(source: SourceRecord): Promise<DocumentRecord[]> {
  const repo = parseGithubRepo(source.uri ?? "");
  if (!repo) {
    throw new Error("GitHub repo uri must look like https://github.com/owner/repo");
  }
  const treeUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/HEAD?recursive=1`;
  const response = await fetch(treeUrl, {
    headers: {
      "user-agent": "comms-agent-agent"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to read GitHub tree: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as {
    tree?: Array<{ path: string; type: string; size?: number }>;
  };
  const candidates =
    payload.tree
      ?.filter((item) => item.type === "blob")
      .filter((item) => TEXT_EXTENSIONS.has(extname(item.path).toLowerCase()))
      .filter((item) => (item.size ?? 0) < 120_000)
      .slice(0, 18) ?? [];

  const documents: DocumentRecord[] = [];
  for (const item of candidates) {
    const rawUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/HEAD/${item.path}`;
    const fileResponse = await fetch(rawUrl);
    if (!fileResponse.ok) {
      continue;
    }
    const text = normalizeWhitespace(await fileResponse.text());
    if (text.length < 40) {
      continue;
    }
    documents.push(
      makeDocument(source, {
        title: item.path,
        text,
        uri: rawUrl,
        metadata: {
          extractor: "github-raw",
          repository: `${repo.owner}/${repo.name}`,
          path: item.path
        }
      })
    );
  }
  return documents;
}

function parseGithubRepo(uri: string): { owner: string; name: string } | undefined {
  const match = uri.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/);
  if (!match) {
    return undefined;
  }
  return {
    owner: match[1],
    name: match[2].replace(/\.git$/, "")
  };
}

function makeDocument(
  source: SourceRecord,
  input: { title: string; text: string; uri?: string; metadata?: Record<string, unknown> }
): DocumentRecord {
  const text = normalizeWhitespace(input.text);
  const contentHash = sha256(text);
  return {
    id: stableId("doc", `${source.id}:${input.uri ?? input.title}:${contentHash}`),
    sourceId: source.id,
    uri: input.uri,
    title: input.title,
    text,
    contentHash,
    metadata: {
      kind: source.kind,
      ...(input.metadata ?? {})
    },
    createdAt: new Date().toISOString()
  };
}

function extractorForPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".pdf") {
    return "pdf-parse";
  }
  if (extension === ".html") {
    return "readability";
  }
  return "plain-text";
}

function safeDomUrl(uri: string): string {
  if (/^https?:\/\//i.test(uri)) {
    return uri;
  }
  return `file://${uri.startsWith("/") ? uri : `/${uri}`}`;
}
