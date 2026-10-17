"use strict";

const yauzl = require("yauzl");

const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED_BYTES = 30 * 1024 * 1024;
const MAX_XML_BYTES = 2 * 1024 * 1024;
const REQUIRED_ENTRIES = new Set([
  "[Content_Types].xml",
  "word/document.xml"
]);

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true
    }, (error, zipfile) => {
      if (error) return reject(error);
      resolve(zipfile);
    });
  });
}

function readEntry(zipfile, entry, limit) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);

      const chunks = [];
      let total = 0;

      stream.on("data", chunk => {
        total += chunk.length;

        if (total > limit) {
          stream.destroy(new Error("DOCX_XML_TOO_LARGE"));
          return;
        }

        chunks.push(chunk);
      });

      stream.on("error", reject);
      stream.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
  });
}

async function validateDocx(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error("INVALID_DOCX");
  }

  const zipfile = await openZip(buffer);

  try {
    const requiredContent = new Map();
    let entriesSeen = 0;
    let totalUncompressed = 0;

    await new Promise((resolve, reject) => {
      zipfile.on("error", reject);

      zipfile.on("entry", async entry => {
        try {
          entriesSeen += 1;

          if (entriesSeen > MAX_ENTRIES) {
            throw new Error("DOCX_TOO_MANY_ENTRIES");
          }

          const name = entry.fileName;

          if (
            !name ||
            name.startsWith("/") ||
            name.includes("\\") ||
            name.split("/").some(part => part === "..") ||
            name.includes("\0")
          ) {
            throw new Error("DOCX_UNSAFE_PATH");
          }

          if ((entry.generalPurposeBitFlag & 1) !== 0) {
            throw new Error("DOCX_ENCRYPTED");
          }

          if (![0, 8].includes(entry.compressionMethod)) {
            throw new Error("DOCX_UNSUPPORTED_COMPRESSION");
          }

          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = unixMode & 0xf000;

          if (fileType === 0xa000) {
            throw new Error("DOCX_SYMLINK");
          }

          const uncompressedSize = entry.uncompressedSize || 0;
          const compressedSize = entry.compressedSize || 0;

          totalUncompressed += uncompressedSize;

          if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
            throw new Error("DOCX_EXPANSION_LIMIT");
          }

          if (
            uncompressedSize > 1024 * 1024 &&
            uncompressedSize > Math.max(compressedSize, 1) * 200
          ) {
            throw new Error("DOCX_SUSPICIOUS_COMPRESSION");
          }

          if (REQUIRED_ENTRIES.has(name)) {
            if (requiredContent.has(name)) {
              throw new Error("DOCX_DUPLICATE_REQUIRED_ENTRY");
            }

            if (uncompressedSize > MAX_XML_BYTES) {
              throw new Error("DOCX_XML_TOO_LARGE");
            }

            const content = await readEntry(
              zipfile,
              entry,
              MAX_XML_BYTES
            );

            requiredContent.set(name, content);
          }

          zipfile.readEntry();
        } catch (error) {
          reject(error);
        }
      });

      zipfile.on("end", resolve);
      zipfile.readEntry();
    });

    const contentTypes = requiredContent.get("[Content_Types].xml");
    const document = requiredContent.get("word/document.xml");

    if (
      !contentTypes ||
      !/<Types(?:\s|>)/i.test(contentTypes) ||
      !document ||
      !/<w:document(?:\s|>)/i.test(document) ||
      !/<w:body(?:\s|>)/i.test(document)
    ) {
      throw new Error("INVALID_DOCX_STRUCTURE");
    }

    return {
      bytes: buffer.length,
      format: "docx"
    };
  } finally {
    zipfile.close();
  }
}

module.exports = validateDocx;
