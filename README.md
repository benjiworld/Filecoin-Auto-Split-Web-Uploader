# Filecoin Auto-Split Web Uploader

A self-hosted web application that uploads files to the Filecoin network with automatic CAR packing, intelligent chunk splitting, and real-time progress tracking.

## Features

- **Automatic CAR Packing**: Files are packed into Content Addressable Archives (CAR) using `ipfs-car`.
- **Intelligent Chunk Splitting**: Files larger than 32MB are automatically split into optimal chunk sizes using `carbites` with the `treewalk` strategy.
- **Real-Time Progress**: Server-Sent Events (SSE) provide live progress updates for upload, packing, splitting, and import stages.
- **Dataset Management**: Upload history, payment status, and piece deletion with on-chain transaction confirmation.
- **Secure Configuration**: Private keys and RPC endpoints are loaded from environment variables only.
- **Large File Support**: Extended socket timeouts allow uploads of multi-gigabyte files.

## Requirements

- **Node.js** version 18.x or later (LTS recommended)
- **npm** version 9.x or later
- **npx** (included with npm)
- A Filecoin wallet with a private key
- Access to a Filecoin RPC endpoint
- A Filecoin Dataset ID (created via the Filecoin Pin CLI or dashboard)

## Installation

### 1. Clone or download the project

Ensure you have the following files in your project directory:

```text
your-project/
├── server.mjs
└── public/
    ├── index.html
    └── app.js
```

If you do not already have these files, obtain them from your source repository or backup.

### 2. Install Node.js dependencies

From the project root directory:

```bash
npm init -y
npm install express multer
```

This installs:

- `express`: Web server framework.
- `multer`: Multipart form data parser for file uploads.

No other Node.js packages are required. The Filecoin CLI tools (`filecoin-pin`, `ipfs-car`, `carbites`) are installed automatically via `npx` on first use.

### 3. Create the environment file

Create a `.env` file in the project root:

```bash
nano .env
```

Add the following variables:

```env
PORT=3000
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
DATASET_ID=99
RPC_URL=https://your-filecoin-rpc-endpoint.example.com
FILECOIN_PIN_VERSION=YOUR_TESTED_VERSION
```

**Important security notes:**

- `PRIVATE_KEY` must start with `0x`.
- Never commit `.env` to version control.
- Add `.env` to your `.gitignore` file.
- Restrict file permissions:

  ```bash
  chmod 600 .env
  ```

### 4. Create the uploads directory

The server stores temporary upload data here:

```bash
mkdir -p uploads
chmod 700 uploads
```

### 5. Verify the setup

Check that Node.js can parse the server file:

```bash
node --check server.mjs
```

If there are no errors, start the server:

```bash
node --env-file=.env server.mjs
```

You should see:

```text
Filecoin uploader listening on http://localhost:3000 (Dataset 99)
```

Open your browser and navigate to:

```text
http://localhost:3000
```

## Usage

### Upload a file or folder

1. Select **Single File** or **Folder / Directory**.
2. Choose the file or folder to upload.
3. Click **1. Process and Upload**.
4. Monitor progress:
   - Uploading to Server
   - Packing to CAR
   - Splitting CAR (if needed)
   - Importing Chunks to Filecoin
5. Upon completion, the IPFS Root CID and Piece CIDs are displayed.

### View upload history

Click **2. View Upload History** to see all pieces stored in your dataset, grouped by original file. Each entry shows:

- Original filename
- Root CID
- Piece CID
- Size
- Copy and Delete buttons

### Check payment status

Click **3. Check Payments Status** to view your Filecoin wallet payment status via the `filecoin-pin payments status` command.

### Delete files

In the history table, click **Delete File** to remove all pieces belonging to that file. A confirmation dialog will appear. Deletion waits for on-chain transaction confirmation before reporting success.

## API Endpoints

### `GET /`

Serves the static frontend (`public/index.html`).

### `GET /api/config`

Returns the current dataset ID:

```json
{ "datasetId": 99 }
```

### `POST /upload-target`

Multipart form upload endpoint. Accepts:

- `files[]`: One or more files.
- `paths[]`: Corresponding relative paths.

Returns:

```json
{ "jobId": "uuid-string" }
```

### `GET /status/:jobId`

Server-Sent Events stream for real-time upload progress.

Event types:

- `packing`
- `rootcid`
- `splitting`
- `chunkinit`
- `chunkprogress`
- `chunkdone`
- `pipelineerror`
- `done`

### `GET /api/history`

Returns dataset piece history:

```json
{
  "datasetId": 99,
  "pieces": [
    {
      "pieceNumber": 1,
      "status": "active",
      "pieceCid": "bafk...",
      "size": "1.00 GiB",
      "originalfile": "example.zip",
      "rootcid": "bafy..."
    }
  ]
}
```

### `POST /api/delete`

Deletes one or more pieces:

```json
{ "pieceCids": ["bafk...", "bafk..."] }
```

Response:

```json
{ "success": true, "message": "Removed and confirmed 2 piece(s)." }
```

### `GET /api/payments`

Returns raw output from `filecoin-pin payments status`.

## Configuration

### Environment variables

| Variable               | Description                                      | Example                          |
|----------------------|--------------------------------------------------|----------------------------------|
| `PORT`               | HTTP server port                                 | `3000`                           |
| `PRIVATE_KEY`        | Filecoin wallet private key (must start with `0x`) | `0xabc...`                       |
| `DATASET_ID`         | Target Filecoin Dataset ID                       | `99`                             |
| `RPC_URL`            | Filecoin RPC endpoint                            | `https://rpc.example.com`        |
| `FILECOIN_PIN_VERSION` | Pinned version of `filecoin-pin` CLI           | `1.2.3`                          |

### File size limits

Default limits in `server.mjs`:

- Maximum upload size: **5 GB**
- Maximum number of files per request: **10,000**
- CAR split threshold: **32 MB**
- Maximum CAR size: **1,065,353,216 bytes** (~1.01 GB)

To adjust these, edit the constants near the top of `server.mjs`.

### Socket timeouts

Large file uploads use extended timeouts:

- Request timeout: **30 minutes**
- Headers timeout: **31 minutes**

To change, modify `extendUploadTimeout` and server timeout settings in `server.mjs`.

## Security considerations

- **Private key**: Never hardcode `PRIVATE_KEY` in source files. Use `.env` or deployment secrets.
- **File permissions**: Restrict `.env` and `uploads` directory permissions.
- **Network exposure**: By default, the server listens on `localhost:3000`. To expose it publicly, use a reverse proxy (e.g., Nginx, Caddy) with HTTPS.
- **Rate limiting**: Consider adding rate limiting middleware for production deployments.

## Troubleshooting

### `PRIVATE_KEY is required`

Ensure `.env` exists and contains a valid `PRIVATE_KEY` starting with `0x`.

### `FILECOIN_PIN_VERSION is required`

Set `FILECOIN_PIN_VERSION` in `.env` to a tested CLI version. Do not use `@latest` in production.

### `Request aborted` or `socket hang up`

- The client disconnected before the upload completed.
- Increase socket timeouts in `server.mjs`.
- Ensure stable network connectivity.
- Check for proxy or load balancer timeouts.

### `Could not detect an IPFS root CID`

- The `ipfs-car pack` command failed or produced unexpected output.
- Verify `ipfs-car` compatibility by running manually:

  ```bash
  npx --yes ipfs-car pack your-file -o test.car
  ```

### `Failed to remove piece`

- The `filecoin-pin remove` command failed.
- Check RPC connectivity and wallet balance.
- Ensure the piece exists and is not already removed.

### Browser shows old page after updates

Force-refresh:

- **Windows/Linux**: `Ctrl + Shift + R`
- **macOS**: `Cmd + Shift + R`

Or clear browser cache.

## Development

### Project structure

```text
your-project/
├── .env                 # Environment variables (do not commit)
├── .gitignore           # Ignore .env and uploads
├── server.mjs           # Main server file
├── uploads/             # Temporary upload directory
└── public/
    ├── index.html       # Frontend HTML
    └── app.js           # Frontend JavaScript
```

### Recommended `.gitignore`

```text
node_modules/
.env
uploads/
*.log
.DS_Store
```

### Running in development

```bash
node --env-file=.env server.mjs
```

### Running in production

- Use a process manager such as `pm2`:

  ```bash
  npm install -g pm2
  pm2 start server.mjs --name filecoin-uploader -- --env-file=.env
  pm2 save
  pm2 startup
  ```

- Configure a reverse proxy (Nginx, Caddy) for HTTPS and domain routing.
- Set appropriate firewall rules.

## License

This project is provided as-is for educational and operational use. Review and adapt for your security and compliance requirements.

## Support

For issues related to:

- **Filecoin Pin CLI**: Consult the [filecoin-pin repository](https://github.com/filecoin-project/filecoin-pin).
- **ipfs-car / carbites**: Consult their respective repositories.
- **This uploader**: Review logs in the server console and browser developer console.