require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { OBSWebSocket } = require('obs-websocket-js');
const {
  CHUNK_LENGTH_SECONDS,
  CHUNK_DIR,
  TRANSCRIPT_DIR,
  extractChunk,
  transcribeAudioAzure,
  cleanChunksAndTranscriptFile,
  publishTranscript,
  cleanTranscript,
  markVideoLive,
  getYouTubeVideoId,
} = require('./utils');

const args = process.argv.slice(2);

if (args.length < 1) {
  console.error('Error: Missing required argument: video-url.');
  console.error('Usage: node index.js <video-url>');
  process.exit(1);
}

const videoUrl = args[0];
const videoId = getYouTubeVideoId(videoUrl);

if (!videoId) {
  console.error('Error: Invalid YouTube video URL.');
  process.exit(1);
}

const streamId = Date.now().toString();

let chunkIdentificationDelay = 0;

let stopTranscription = false;

if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR);
if (!fs.existsSync(TRANSCRIPT_DIR)) fs.mkdirSync(TRANSCRIPT_DIR);

cleanTranscript();

async function start(videoPath) {
  let offset = 0;
  const startedAt = Date.now();

  while (true) {
    if (stopTranscription) {
      console.log('🛑 Stopping transcription...');
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, CHUNK_LENGTH_SECONDS * 1000));
    try {
      const chunkPath = await extractChunk(videoPath, offset);
      if (offset === 0) {
        const firstChunkExtractedAt = Date.now();
        chunkIdentificationDelay =
          firstChunkExtractedAt - startedAt - CHUNK_LENGTH_SECONDS * 1000;
      }
      console.log(
        `📤 Chunk ${offset / CHUNK_LENGTH_SECONDS} identified at: `,
        new Date().toISOString()
      );
      transcribeAudioAzure(chunkPath, offset)
        .then(({ text, timeRange }) => {
          console.log(
            '📤 publishing transcribe at: ',
            new Date().toISOString()
          );
          publishTranscript(text, timeRange, streamId);
          fs.unlinkSync(chunkPath);
        })
        .catch((err) => {});

      offset += CHUNK_LENGTH_SECONDS;
    } catch (err) {}
  }
}

const obsInstance = new OBSWebSocket();

obsInstance.connect('ws://localhost:4455', undefined);

obsInstance.on('Identified', async () => {
  console.log('Connected to OBS');
  markVideoLive(videoId, streamId)
    .then(() => {
      videoMarkedLive = true;
    })
    .catch((err) => {
      console.error('Error marking video live:', err.message);
      process.exit(1);
    });
});

obsInstance.on('ConnectionClosed', async () => {
  console.log('OBS connection closed');
});

obsInstance.on('ConnectionError', async () => {
  console.error('OBS connection error');
});

obsInstance.on('RecordStateChanged', async (data) => {
  if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
    console.log('📝 Recording started at:', new Date().toISOString());
    stopTranscription = false;
    chunkIdentificationDelay = 0;
    cleanTranscript();
    start(data.outputPath);
  } else if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
    setTimeout(() => {
      stopTranscription = true;
    }, CHUNK_LENGTH_SECONDS * 1000);
  }
});

process.on('SIGINT', () => {
  console.log('\n🚪 Exiting... Cleaning up.');
  cleanChunksAndTranscriptFile();
  process.exit();
});

process.on('SIGTERM', () => {
  console.log('\n🚪 Termination signal received. Cleaning up.');
  cleanChunksAndTranscriptFile();
  process.exit();
});

process.on('exit', () => {
  cleanChunksAndTranscriptFile();
});
