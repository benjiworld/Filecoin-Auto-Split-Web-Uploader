import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFilePromise = promisify(execFile);
const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const DATASET_ID = Number(process.env.DATASET_ID);
const RPC_URL = process.env.RPC_URL;
const FILECOIN_PIN_VERSION = process.env.FILECOIN_PIN_VERSION;

if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY is required.');
if (!PRIVATE_KEY.startsWith('0x')) throw new Error('PRIVATE_KEY must start with "0x".');
if (!Number.isInteger(DATASET_ID) || DATASET_ID < 0) throw new Error('DATASET_ID must be a non-negative integer.');
if (!RPC_URL) throw new Error('RPC_URL is required.');
if (!FILECOIN_PIN_VERSION) throw new Error('FILECOIN_PIN_VERSION is required.');

const uploadDir = path.resolve('uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_CAR_SIZE = 1065353216;
const MIN_CAR_BOUNDARY = 32 * 1024 * 1024;
const activeJobs = new Map();

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: MAX_UPLOAD_SIZE, files: 10000 }
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const removeAnsi = (value = '') => value.replace(/\x1B\[[0-9;]*[mK]/g, '');

function commandErrorText(error) {
  return [error?.message, error?.stdout, error?.stderr]
    .filter(Boolean)
    .map(removeAnsi)
    .join('\n')
    .trim();
}

async function runFilecoinPin(args, options = {}) {
  return execFilePromise(
    'npx',
    ['--yes', `filecoin-pin@${FILECOIN_PIN_VERSION}`, ...args],
    { maxBuffer: 20 * 1024 * 1024, windowsHide: true, ...options }
  );
}

async function runIpfsCar(args, options = {}) {
  return execFilePromise(
    'npx',
    ['--yes', 'ipfs-car', ...args],
    { maxBuffer: 20 * 1024 * 1024, windowsHide: true, ...options }
  );
}

async function runCarbites(args, options = {}) {
  return execFilePromise(
    'npx',
    ['--yes', 'carbites', ...args],
    { maxBuffer: 20 * 1024 * 1024, windowsHide: true, ...options }
  );
}

function normalizePieceCids(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.pieceCids)) return body.pieceCids;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.pieceCids)) return parsed.pieceCids;
    } catch {}
  }
  return [];
}

function isValidPieceCid(value) {
  return typeof value === 'string' && value.length >= 10 && /^[a-zA-Z0-9]+$/.test(value);
}

function isRetryableRemoveError(error) {
  const text = commandErrorText(error);
  return text.includes('Request timed out after 5000ms') ||
    text.includes('requested confirmation wait timed out') ||
    error?.code === 2;
}

async function removeWithRetry(args, pieceCid, maxRetries = 10) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      console.log(`Removing piece ${pieceCid}: attempt ${attempt}/${maxRetries}`);
      const { stdout, stderr } = await runFilecoinPin(args);

      if (stderr?.trim()) {
        console.warn(`Remove stderr for ${pieceCid}:\n${removeAnsi(stderr)}`);
      }

      console.log(`Removed piece ${pieceCid} after confirmation.`);
      return stdout;
    } catch (error) {
      lastError = error;

      if (isRetryableRemoveError(error) && attempt < maxRetries) {
        const delay = crypto.randomInt(2000, 5001);
        console.warn(`Retrying removal of ${pieceCid} in ${delay}ms.`);
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    `Failed to remove piece ${pieceCid} after ${maxRetries} attempts.\n${commandErrorText(lastError)}`
  );
}

function safeUploadPath(baseDir, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    !relativePath.trim() ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('Invalid upload path.');
  }

  const normalized = path.normalize(relativePath)
    .replace(/^(\.\.(\/|\\|$))+/, '')
    .replace(/^[/\\]+/, '');

  const destination = path.resolve(baseDir, normalized);

  if (!destination.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error('Upload path escapes its job directory.');
  }

  return destination;
}

function safeMetadataValue(value, maxLength = 32) {
  return String(value || '').replace(/[\r\n\0]/g, '').slice(0, maxLength);
}

function getRootTargetName(paths) {
  const roots = [
    ...new Set(
      paths
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.split(/[\\/]/)[0])
        .filter(Boolean)
    )
  ];

  if (roots.length !== 1) {
    throw new Error('Folder uploads must have one common top-level directory or file.');
  }

  return roots[0];
}

function createJob(jobId) {
  const job = {
    jobId,
    events: [],
    nextEventId: 1,
    response: null,
    completed: false,
    cleanupTimer: null
  };

  activeJobs.set(jobId, job);
  return job;
}

function formatSseEvent(record) {
  return [
    `id: ${record.id}`,
    `event: ${record.event}`,
    `data: ${record.data}`,
    '',
    ''
  ].join('\n');
}

function sendJobEvent(jobId, event, data) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  const record = {
    id: job.nextEventId,
    event,
    data: String(data).replace(/\r/g, '').replace(/\n/g, '\\n')
  };

  job.nextEventId += 1;
  job.events.push(record);

  if (job.response && !job.response.writableEnded) {
    job.response.write(formatSseEvent(record));
  }
}

function completeJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  job.completed = true;

  if (job.response && !job.response.writableEnded) {
    job.response.end();
  }

  job.cleanupTimer = setTimeout(() => {
    const current = activeJobs.get(jobId);

    if (current?.response && !current.response.writableEnded) {
      current.response.end();
    }

    activeJobs.delete(jobId);
  }, 5 * 60 * 1000);
}

function extractCid(output) {
  const matches = removeAnsi(output).match(
    /\b(bafy[a-z0-9]+|bafk[a-z0-9]+)\b/gi
  );

  return matches?.at(-1) || null;
}

function chooseBestBoundary(size) {
  let best = MAX_CAR_SIZE;
  let lowestWaste = Number.POSITIVE_INFINITY;

  for (
    let boundary = MAX_CAR_SIZE;
    boundary >= MIN_CAR_BOUNDARY;
    boundary = Math.floor(boundary / 2)
  ) {
    const finalSize = size % boundary || boundary;
    let padded = MIN_CAR_BOUNDARY;

    while (padded < finalSize) padded *= 2;

    const waste = padded - finalSize;

    if (waste <= lowestWaste) {
      lowestWaste = waste;
      best = boundary;
    }

    if (boundary === MIN_CAR_BOUNDARY) break;
  }

  return best;
}

app.get('/api/config', (req, res) => {
  res.json({ datasetId: DATASET_ID });
});

app.get('/status/:jobId', (req, res) => {
  const job = activeJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Upload job not found or expired.' });
  }

  const parsedLastEventId = Number(req.get('Last-Event-ID') || 0);
  const lastEventId = Number.isFinite(parsedLastEventId) ? parsedLastEventId : 0;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (job.response && !job.response.writableEnded) job.response.end();
  job.response = res;

  for (const record of job.events) {
    if (record.id > lastEventId) res.write(formatSseEvent(record));
  }

  if (job.completed) {
    res.end();
    return;
  }

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    if (job.response === res) job.response = null;
  });
});

app.post('/upload-target', upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).send('No files uploaded.');
  }

  const jobId = crypto.randomUUID();
  const tempJobFolder = path.join(uploadDir, `job_${jobId}`);

  try {
    fs.mkdirSync(tempJobFolder, { recursive: true });

    const uploadedPaths = Array.isArray(req.body.paths)
      ? req.body.paths
      : [req.body.paths];

    if (uploadedPaths.length !== req.files.length) {
      throw new Error('File and relative-path counts do not match.');
    }

    const rootTargetName = getRootTargetName(uploadedPaths);

    req.files.forEach((file, index) => {
      const destination = safeUploadPath(tempJobFolder, uploadedPaths[index]);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(file.path, destination);
    });

    const pathToPack = safeUploadPath(tempJobFolder, rootTargetName);
    createJob(jobId);
    res.json({ jobId });

    runPipeline(jobId, pathToPack, rootTargetName, tempJobFolder)
      .catch(error => console.error('Unexpected pipeline failure:', commandErrorText(error)));
  } catch (error) {
    console.error('Upload preparation failed:', commandErrorText(error));

    for (const file of req.files || []) {
      try { fs.rmSync(file.path, { force: true }); } catch {}
    }

    fs.rmSync(tempJobFolder, { recursive: true, force: true });
    res.status(400).send(error.message || 'Could not prepare upload.');
  }
});

async function runPipeline(jobId, pathToPack, rootTargetName, tempJobFolder) {
  const carFilePath = path.join(tempJobFolder, `${rootTargetName}.car`);

  try {
    sendJobEvent(jobId, 'packing', 'start');

    const { stdout: packStdout, stderr: packStderr } = await runIpfsCar(
      ['pack', pathToPack, '-o', carFilePath],
      { cwd: tempJobFolder }
    );

    if (packStderr?.trim()) console.warn(`ipfs-car stderr:\n${removeAnsi(packStderr)}`);

    const rootCid = extractCid(packStdout);
    if (!rootCid) {
      throw new Error(`Could not detect an IPFS root CID from ipfs-car output.\n${removeAnsi(packStdout)}`);
    }

    sendJobEvent(jobId, 'rootcid', rootCid);
    sendJobEvent(jobId, 'packing', 'done');

    const carFileSize = fs.statSync(carFilePath).size;
    let filesToUpload = [];

    if (carFileSize <= MIN_CAR_BOUNDARY) {
      sendJobEvent(jobId, 'splitting', 'skipped under 32MB');
      filesToUpload.push(path.basename(carFilePath));
    } else {
      sendJobEvent(jobId, 'splitting', 'start');
      const bestBoundary = chooseBestBoundary(carFileSize);

      if (bestBoundary >= carFileSize && carFileSize <= MAX_CAR_SIZE) {
        sendJobEvent(jobId, 'splitting', 'skipped already optimal');
        filesToUpload.push(path.basename(carFilePath));
      } else {
        const { stdout: splitStdout, stderr: splitStderr } = await runCarbites(
          ['split', carFilePath, '--size', String(bestBoundary), '--strategy', 'treewalk'],
          { cwd: tempJobFolder }
        );

        console.log(`carbites output:\n${removeAnsi(splitStdout)}`);
        if (splitStderr?.trim()) console.warn(`carbites stderr:\n${removeAnsi(splitStderr)}`);

        filesToUpload = fs.readdirSync(tempJobFolder)
          .filter(fileName => fileName.endsWith('.car') && fileName !== path.basename(carFilePath))
          .sort();

        if (filesToUpload.length === 0) filesToUpload.push(path.basename(carFilePath));
        sendJobEvent(jobId, 'splitting', 'done');
      }
    }

    sendJobEvent(jobId, 'chunkinit', String(filesToUpload.length));

    for (let index = 0; index < filesToUpload.length; index += 1) {
      const fileName = filesToUpload[index];
      const uploadPath = path.join(tempJobFolder, fileName);

      sendJobEvent(jobId, 'chunkprogress', JSON.stringify({ index, pct: 5 }));
      const progressTimer = setInterval(() => {
        sendJobEvent(jobId, 'chunkprogress', JSON.stringify({ index, pct: 80 }));
      }, 2500);

      try {
        const { stdout, stderr } = await runFilecoinPin([
          'import',
          uploadPath,
          '--private-key', PRIVATE_KEY,
          '--rpc-url', RPC_URL,
          '--data-set-id', String(DATASET_ID),
          '--copies', '2',
          '--auto-fund',
          '--metadata', `original_file=${safeMetadataValue(rootTargetName)}`,
          '--metadata', `root_cid=${safeMetadataValue(rootCid, 128)}`
        ], { cwd: tempJobFolder });

        clearInterval(progressTimer);
        console.log(`Import output for ${fileName}:\n${removeAnsi(stdout)}`);
        if (stderr?.trim()) console.warn(`Import stderr for ${fileName}:\n${removeAnsi(stderr)}`);

        sendJobEvent(jobId, 'chunkprogress', JSON.stringify({ index, pct: 100 }));
        sendJobEvent(jobId, 'chunkdone', JSON.stringify({ index, cid: extractCid(stdout) || 'Unknown CID' }));
      } catch (error) {
        clearInterval(progressTimer);
        throw error;
      }
    }

    sendJobEvent(jobId, 'done', 'success');
  } catch (error) {
    const details = commandErrorText(error) || 'Unknown upload pipeline error.';
    console.error(`Pipeline failed for job ${jobId}:\n${details}`);
    sendJobEvent(jobId, 'pipelineerror', JSON.stringify({ message: details.slice(0, 12000) }));
    sendJobEvent(jobId, 'done', 'failed');
  } finally {
    fs.rmSync(tempJobFolder, { recursive: true, force: true });
    completeJob(jobId);
  }
}

app.get('/api/history', async (req, res) => {
  try {
    const { stdout, stderr } = await runFilecoinPin([
      'data-set', 'piece-status', String(DATASET_ID), '--rpc-url', RPC_URL
    ]);

    const output = [removeAnsi(stdout), removeAnsi(stderr)].filter(Boolean).join('\n');
    const pieces = [];
    let currentPiece = null;
    const clean = value => String(value).trim().replace(/^["']/, '').replace(/["']$/, '').trim();

    for (const rawLine of output.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      const record = line.match(/^#(\d+)\s+\(([^)]+)\)\s*$/i);
      if (record) {
        if (currentPiece?.pieceCid) pieces.push(currentPiece);
        currentPiece = {
          pieceNumber: Number(record[1]),
          status: record[2].trim(),
          pieceCid: 'Unknown',
          size: 'Unknown',
          originalfile: 'Unknown',
          rootcid: 'Unknown'
        };
        continue;
      }

      if (!currentPiece) continue;

      let match = line.match(/^PieceCID:\s*(.+?)\s*$/i);
      if (match) { currentPiece.pieceCid = clean(match[1]); continue; }
      match = line.match(/^Size:\s*(.+?)\s*$/i);
      if (match) { currentPiece.size = clean(match[1]); continue; }
      match = line.match(/^(?:ipfsRootCID|root_cid):\s*(.+?)\s*$/i);
      if (match) { const value = clean(match[1]); currentPiece.rootcid = value && value !== '-' ? value : 'Unknown'; continue; }
      match = line.match(/^(?:originalfile|original_file):\s*(.+?)\s*$/i);
      if (match) { const value = clean(match[1]); currentPiece.originalfile = value && value !== '-' ? value : 'Unknown'; continue; }
      match = line.match(/^name:\s*(.+?)\s*$/i);
      if (match && currentPiece.originalfile === 'Unknown') currentPiece.originalfile = clean(match[1]);
    }

    if (currentPiece?.pieceCid) pieces.push(currentPiece);

    const valid = pieces.filter(piece =>
      piece &&
      piece.status.toLowerCase() === 'active' &&
      /^bafk[a-z0-9]+$/i.test(piece.pieceCid)
    );

    res.json({ datasetId: DATASET_ID, pieces: valid.reverse() });
  } catch (error) {
    console.error('History query failed:', commandErrorText(error));
    res.status(500).json({ error: commandErrorText(error) || 'Could not fetch dataset history.' });
  }
});

app.post('/api/delete', async (req, res) => {
  const pieceCids = normalizePieceCids(req.body);

  if (!pieceCids.length || !pieceCids.every(isValidPieceCid)) {
    return res.status(400).json({ error: 'Provide one or more valid Piece CIDs.' });
  }

  try {
    for (const pieceCid of pieceCids) {
      await removeWithRetry([
        'remove',
        '--piece', pieceCid,
        '--data-set-id', String(DATASET_ID),
        '--private-key', PRIVATE_KEY,
        '--rpc-url', RPC_URL,
        '--wait'
      ], pieceCid, 10);
    }

    res.json({ success: true, message: `Removed and confirmed ${pieceCids.length} piece(s).` });
  } catch (error) {
    console.error('Delete failed:', commandErrorText(error));
    res.status(500).json({ error: commandErrorText(error) || 'Failed to remove one or more pieces.' });
  }
});

app.get('/api/payments', async (req, res) => {
  try {
    const { stdout, stderr } = await runFilecoinPin([
      'payments', 'status', '--private-key', PRIVATE_KEY, '--rpc-url', RPC_URL
    ]);

    if (stderr?.trim()) console.warn(`Payments stderr:\n${removeAnsi(stderr)}`);
    res.json({ success: true, output: removeAnsi(stdout) });
  } catch (error) {
    console.error('Payments query failed:', commandErrorText(error));
    res.status(500).json({ error: commandErrorText(error) || 'Could not retrieve payment status.' });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${error.message}` });
  }

  console.error('Unhandled request error:', error);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(port, () => {
  console.log(`Filecoin uploader listening on http://localhost:${port} (Dataset ${DATASET_ID})`);
});
