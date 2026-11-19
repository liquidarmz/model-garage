import JSZip from 'jszip';

type Downloads = { save(r: { filename: string; data: Blob }): Promise<{ status: string }> };
type Host = { use(name: string): Promise<unknown> };

/**
 * Save a generated file. In a normal browser tab this is a plain download.
 * When the app runs as a hosted Claude page, downloads go through the host's
 * save prompt, which does not accept .3mf, so the file is wrapped in a .zip.
 * Returns the name the user will see.
 */
export async function saveFile(filename: string, bytes: Uint8Array): Promise<string> {
  const host = (window as unknown as { claude?: Host }).claude;
  if (host?.use) {
    const downloads = (await host.use('downloads')) as Downloads | null;
    if (downloads) {
      const zip = new JSZip();
      zip.file(filename, bytes);
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const zipName = filename.replace(/\.[^.]+$/, '') + '.zip';
      try {
        await downloads.save({ filename: zipName, data: blob });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'declined') throw new Error('Download cancelled.');
        throw new Error(`Could not save the file here (${code ?? 'unavailable'}).`);
      }
      return `${zipName} (unzip it to get ${filename})`;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/3mf' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return filename;
}
