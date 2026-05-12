import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';

// Synapse SDK Imports
import { Synapse } from '@filoz/synapse-sdk';
import { mainnet } from '@filoz/synapse-core/chains'; 
import { privateKeyToAccount } from 'viem/accounts';

const execPromise = promisify(exec);
const app = express();
const port = 3000;

// Setup directories and limits (5GB limit)
const uploadDir = path.resolve('uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 * 1024 } 
});

// Configure your Filecoin wallet & Dataset
const PRIVATE_KEY = '0x_YOUR_PRIVATE_KEY_HERE';
const DATASET_ID = 99; // Ensures files show up in 'filecoin-pin dataset show 99'

// Maximum size for a single Filecoin deal via Synapse (~1 GiB)
const MAX_CAR_SIZE = 1065353216;

// In-memory store to track background jobs and send SSE updates
const activeJobs = new Map();

// --- 1. FRONTEND UI ---
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Filecoin Auto-Split Uploader</title>
            <style>
                body { font-family: system-ui, sans-serif; background: #f4f7f6; padding: 2rem; display: flex; justify-content: center; }
                .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 600px; }
                .progress-container { margin-top: 15px; display: none; }
                .step { margin-bottom: 15px; }
                .step-label { font-weight: bold; margin-bottom: 5px; font-size: 14px; color: #333; display: flex; justify-content: space-between; }
                .bar-bg { width: 100%; background: #e0e0e0; height: 12px; border-radius: 6px; overflow: hidden; }
                .bar-fill { height: 100%; background: #0090ff; width: 0%; transition: width 0.2s ease; }
                .indeterminate { background: repeating-linear-gradient(45deg, #0090ff, #0090ff 10px, #4facfe 10px, #4facfe 20px); background-size: 200% 200%; animation: stripes 2s linear infinite; }
                @keyframes stripes { 100% { background-position: -100% 0; } }
                button { background: #0090ff; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 16px; margin-top: 10px; width: 100%; }
                button:disabled { background: #ccc; cursor: not-allowed; }
                .radio-group { margin-bottom: 15px; font-size: 15px; }
                .radio-group label { margin-right: 15px; cursor: pointer; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>Upload to Filecoin</h2>
                <p style="font-size: 14px; color: #666;">Upload a file or folder. It will be packed into a .CAR, automatically split if >1GB, and pinned to the Mainnet.</p>
                
                <div class="radio-group">
                    <label><input type="radio" name="uploadType" value="file" checked onchange="toggleMode('file')"> Single File</label>
                    <label><input type="radio" name="uploadType" value="folder" onchange="toggleMode('folder')"> Folder Directory</label>
                </div>

                <input type="file" id="fileInput" style="margin-bottom: 15px; width: 100%;" />
                <button id="uploadBtn" onclick="startProcess()">Process & Upload to Filecoin</button>

                <div id="ui-progress" class="progress-container">
                    <div class="step">
                        <div class="step-label"><span>1. Uploading to Server</span><span id="lbl-upload">0%</span></div>
                        <div class="bar-bg"><div id="bar-upload" class="bar-fill"></div></div>
                    </div>
                    
                    <div class="step">
                        <div class="step-label"><span>2. Packing to .CAR</span><span id="lbl-packing">Waiting...</span></div>
                        <div class="bar-bg"><div id="bar-packing" class="bar-fill"></div></div>
                    </div>

                    <div class="step">
                        <div class="step-label"><span>3. Carbites Splitting (>1GB)</span><span id="lbl-splitting">Waiting...</span></div>
                        <div class="bar-bg"><div id="bar-splitting" class="bar-fill"></div></div>
                    </div>

                    <div id="final-results" style="margin-top: 20px; font-size: 14px; color: #333; font-weight: normal;"></div>
                    <div id="filecoin-chunks" style="margin-top: 20px;"></div>
                </div>
            </div>

            <script>
                function toggleMode(mode) {
                    const input = document.getElementById('fileInput');
                    if (mode === 'folder') {
                        input.setAttribute('webkitdirectory', '');
                        input.setAttribute('multiple', '');
                    } else {
                        input.removeAttribute('webkitdirectory');
                        input.removeAttribute('multiple');
                    }
                    input.value = ''; 
                }

                function updateBar(id, percent, text) {
                    document.getElementById('bar-' + id).style.width = percent + '%';
                    if(text) document.getElementById('lbl-' + id).innerText = text;
                }

                function setIndeterminate(id, text) {
                    const bar = document.getElementById('bar-' + id);
                    bar.style.width = '100%';
                    bar.classList.add('indeterminate');
                    document.getElementById('lbl-' + id).innerText = text;
                }

                function finishIndeterminate(id, customText = 'Done', color = '#28a745') {
                    const bar = document.getElementById('bar-' + id);
                    bar.classList.remove('indeterminate');
                    bar.style.width = '100%';
                    bar.style.background = color; 
                    document.getElementById('lbl-' + id).innerText = customText;
                }

                function startProcess() {
                    const fileInput = document.getElementById('fileInput');
                    if (!fileInput.files.length) return alert('Please select a file or folder.');
                    
                    document.getElementById('uploadBtn').disabled = true;
                    document.getElementById('ui-progress').style.display = 'block';

                    const formData = new FormData();
                    
                    for (let i = 0; i < fileInput.files.length; i++) {
                        const file = fileInput.files[i];
                        const path = file.webkitRelativePath || file.name;
                        formData.append('files', file);
                        formData.append('paths', path);
                    }

                    const xhr = new XMLHttpRequest();
                    xhr.upload.onprogress = (e) => {
                        if (e.lengthComputable) {
                            const pct = Math.round((e.loaded / e.total) * 100);
                            updateBar('upload', pct, pct + '%');
                        }
                    };

                    xhr.onload = () => {
                        if (xhr.status === 200) {
                            updateBar('upload', 100, 'Done');
                            document.getElementById('bar-upload').style.background = '#28a745';
                            const { jobId } = JSON.parse(xhr.responseText);
                            listenToJobs(jobId);
                        } else {
                            alert('Server upload failed: ' + xhr.responseText);
                        }
                    };

                    xhr.open('POST', '/upload-target');
                    xhr.send(formData);
                }

                function listenToJobs(jobId) {
                    const source = new EventSource('/status/' + jobId);

                    source.addEventListener('packing', (e) => {
                        if(e.data === 'start') setIndeterminate('packing', 'Processing...');
                        if(e.data === 'done') finishIndeterminate('packing');
                    });

                    source.addEventListener('root_cid', (e) => {
                        document.getElementById('final-results').innerHTML += \`
                            <div style="margin-bottom: 15px; padding: 10px; background: #e8f5e9; border-left: 4px solid #28a745; color: #333;">
                                <strong>IPFS Root CID:</strong><br>
                                <span style="font-family: monospace; word-break: break-all;">\${e.data}</span>
                            </div>\`;
                    });

                    source.addEventListener('splitting', (e) => {
                        if(e.data === 'start') setIndeterminate('splitting', 'Processing...');
                        if(e.data === 'skipped') finishIndeterminate('splitting', 'Skipped (< 1GB)', '#6c757d');
                        if(e.data === 'done') finishIndeterminate('splitting');
                    });

                    source.addEventListener('chunk_init', (e) => {
                        const count = parseInt(e.data);
                        const container = document.getElementById('filecoin-chunks');
                        for(let i=0; i<count; i++) {
                            container.innerHTML += \`
                                <div class="step">
                                    <div class="step-label"><span>4. Uploading Chunk \${i+1}</span><span id="lbl-chunk-\${i}">0%</span></div>
                                    <div class="bar-bg"><div id="bar-chunk-\${i}" class="bar-fill"></div></div>
                                </div>
                            \`;
                        }
                    });

                    source.addEventListener('chunk_progress', (e) => {
                        const data = JSON.parse(e.data);
                        updateBar('chunk-' + data.index, data.pct, data.pct + '%');
                        if (data.pct === 100) document.getElementById('bar-chunk-' + data.index).style.background = '#28a745';
                    });

                    source.addEventListener('chunk_done', (e) => {
                        const data = JSON.parse(e.data);
                        document.getElementById('final-results').innerHTML += \`<div style="margin-bottom: 5px; font-weight: bold; color: green;">✅ Chunk \${data.index + 1} PieceCID: <span style="font-weight: normal; font-family: monospace;">\${data.cid}</span></div>\`;
                    });

                    source.addEventListener('done', () => {
                        document.getElementById('final-results').innerHTML += '<br><b style="font-size:16px; color: green;">All data secured on Filecoin Dataset ' + ${DATASET_ID} + '!</b>';
                        source.close();
                    });
                }
            </script>
        </body>
        </html>
    `);
});

// --- 2. BACKEND UPLOAD HANDLER ---
app.post('/upload-target', upload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).send('No files.');

    const jobId = Date.now().toString();
    const tempJobFolder = path.join(uploadDir, `job_${jobId}`);
    
    fs.mkdirSync(tempJobFolder);

    const paths = [].concat(req.body.paths || []);
    
    req.files.forEach((file, index) => {
        const relativePath = paths[index];
        const fullDestPath = path.join(tempJobFolder, relativePath);
        
        fs.mkdirSync(path.dirname(fullDestPath), { recursive: true });
        fs.renameSync(file.path, fullDestPath);
    });

    const rootTargetName = paths[0].split('/')[0]; 
    const pathToPack = path.join(tempJobFolder, rootTargetName);

    activeJobs.set(jobId, { res: null });
    res.json({ jobId });

    runPipeline(jobId, pathToPack, rootTargetName, tempJobFolder).catch(console.error);
});

// --- 3. SSE STATUS ENDPOINT ---
app.get('/status/:jobId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const job = activeJobs.get(req.params.jobId);
    if (job) job.res = res;
});

// --- 4. THE PIPELINE RUNNER ---
async function runPipeline(jobId, pathToPack, rootTargetName, tempJobFolder) {
    const sendEvent = (event, data) => {
        const job = activeJobs.get(jobId);
        if (job && job.res) job.res.write(`event: ${event}\ndata: ${data}\n\n`);
    };

    const carFilePath = path.join(tempJobFolder, `${rootTargetName}.car`);

    try {
        // Step 1: Pack the folder/file with ipfs-car
        sendEvent('packing', 'start');
        
        const { stdout } = await execPromise(`npx ipfs-car p "${pathToPack}" -o "${carFilePath}"`);
        
        const rootCidMatch = stdout.trim().split('\n').pop();
        if (rootCidMatch) {
            console.log(`Root CID generated: ${rootCidMatch}`);
            sendEvent('root_cid', rootCidMatch);
        }

        sendEvent('packing', 'done');

        // Check the size of the resulting .CAR file
        const carFileSize = fs.statSync(carFilePath).size;
        let filesToUpload = [];

        // Step 2: Conditionally Split if > 1GiB
        if (carFileSize <= MAX_CAR_SIZE) {
            sendEvent('splitting', 'skipped');
            filesToUpload.push(`${rootTargetName}.car`);
        } else {
            sendEvent('splitting', 'start');
            await execPromise(`npx carbites split "${carFilePath}" -s ${MAX_CAR_SIZE} -t treewalk`, { cwd: tempJobFolder });
            sendEvent('splitting', 'done');

            filesToUpload = fs.readdirSync(tempJobFolder)
                .filter(f => f.endsWith('.car') && f !== `${rootTargetName}.car`)
                .sort();
        }

        sendEvent('chunk_init', filesToUpload.length);

        // Step 3: Upload sequentially via Synapse
        const synapse = await Synapse.create({ chain: mainnet, account: privateKeyToAccount(PRIVATE_KEY) });

        for (let i = 0; i < filesToUpload.length; i++) {
            const uploadPath = path.join(tempJobFolder, filesToUpload[i]);
            const totalSize = fs.statSync(uploadPath).size;
            
            const nodeStream = fs.createReadStream(uploadPath);
            const webStream = Readable.toWeb(nodeStream);

            const uploadTask = await synapse.storage.upload(webStream, {
                count: 2, 
                isCar: true, 
                dataSetIds: [BigInt(DATASET_ID)], 
                pieceMetadata: { 
                    name: filesToUpload[i].substring(0, 32),
                    original_file: rootTargetName.substring(0, 32),
                    size_bytes: totalSize.toString(),
                    root_cid: rootCidMatch || 'unknown'
                },
                callbacks: {
                    onProgress: (bytes) => {
                        const pct = Math.min(100, Math.round((bytes / totalSize) * 100));
                        sendEvent('chunk_progress', JSON.stringify({ index: i, pct }));
                    }
                }
            });

            // Extract the actual PieceCID safely from the returned payload
            let actualCid = "Unknown CID";
            if (typeof uploadTask === 'string') {
                actualCid = uploadTask;
            } else if (uploadTask && uploadTask.pieceCid) {
                actualCid = uploadTask.pieceCid.toString();
            } else if (uploadTask && uploadTask.copies && uploadTask.copies.length > 0) {
                actualCid = uploadTask.copies[0].pieceCid.toString();
            } else if (uploadTask && typeof uploadTask.toString === 'function') {
                actualCid = uploadTask.toString();
            }

            sendEvent('chunk_done', JSON.stringify({ index: i, cid: actualCid }));
            console.log(`Uploaded Chunk ${i+1}/${filesToUpload.length}: ${actualCid}`);
        }

        sendEvent('done', 'success');

    } catch (error) {
        console.error("Pipeline failed:", error);
    } finally {
        // Step 4: Cleanup workspace
        console.log(`Cleaning up temporary folder: ${tempJobFolder}`);
        fs.rmSync(tempJobFolder, { recursive: true, force: true });
        activeJobs.delete(jobId);
    }
}

app.listen(port, () => console.log(`Smart Uploader running at http://localhost:${port} (Dataset: ${DATASET_ID})`));
