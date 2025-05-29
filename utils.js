const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const axios = require('axios');

const CHUNK_DIR = './chunks';
const TRANSCRIPT_DIR = './transcripts';
const TRANSCRIPTION_FILE = path.join(TRANSCRIPT_DIR, 'full_transcript.txt');
const CHUNK_LENGTH_SECONDS = 10;

function extractChunk(videoPath, offset, retry = 0) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(CHUNK_DIR, `chunk_${offset}.wav`);

    const ffmpeg = spawn('ffmpeg', [
      '-ss',
      `${offset}`,
      '-t',
      `${CHUNK_LENGTH_SECONDS}`,
      '-i',
      videoPath,
      '-vn',
      '-acodec',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-y',
      outPath,
    ]);

    ffmpeg.on('close', (code) => {
      if (
        code === 0 &&
        fs.existsSync(outPath) &&
        fs.statSync(outPath).size > 10000
      ) {
        resolve(outPath);
      } else {
        if (retry * 100 > 5000) {
          reject(new Error('FFmpeg extraction failed'));
        } else {
          setTimeout(() => {
            extractChunk(videoPath, offset, retry + 1)
              .then(resolve)
              .catch(reject);
          }, 100);
        }
      }
    });
  });
}

async function transcribeAudioAzure(chunkPath, offset) {
  try {
    const audioStream = fs.readFileSync(chunkPath);
    const endpoint = `https://${process.env.AZURE_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`;
    const response = await axios.post(endpoint, audioStream, {
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
        'Content-Type': 'audio/wav',
        Accept: 'application/json',
      },
      params: {
        language: 'hi-IN',
      },
    });

    const text = response.data.DisplayText;
    const timeRange = `[${offset}s - ${offset + CHUNK_LENGTH_SECONDS}s]`;
    const logLine = `${timeRange} ${text}\n`;

    fs.appendFileSync(TRANSCRIPTION_FILE, logLine);
    console.log('📝', logLine.trim());
    return { text, timeRange };
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
    throw err;
  }
}

function cleanChunksAndTranscriptFile() {
  if (fs.existsSync(CHUNK_DIR)) {
    const files = fs.readdirSync(CHUNK_DIR);
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(CHUNK_DIR, file));
      } catch (err) {
        console.error(`Failed to delete chunk ${file}:`, err);
      }
    }
    console.log('🧹 Cleaned up chunk files');
  }
  cleanTranscript();
}

function cleanTranscript() {
  fs.writeFileSync(TRANSCRIPTION_FILE, '');
}

function markVideoLive(videoId, streamId) {
  return axios.post(
    'https://qbg-backend-stage.penpencil.co/qbg/internal/mark-video-live',
    {
      video_id: videoId,
      stream_id: streamId,
    }
  );
}

function publishTranscript(text, timeRange, streamId) {
  axios
    .post(
      'https://qbg-backend-stage.penpencil.co/qbg/internal/push-transcripts',
      {
        stream_id: streamId,
        transcript: {
          text,
          timeline: timeRange,
        },
      }
    )
    .catch((err) => {
      console.error('Error publishing transcript:', err?.message);
    });
}

function getYouTubeVideoId(url) {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;

    // Handle https://youtube.com/live/6AYdWFcTX0A?feature=share
    if (url.includes('youtube.com/live')) {
      const pathParts = parsedUrl.pathname.split('/');
      return pathParts[pathParts.length - 1].split('?')[0];
    }

    // Handle https://www.youtube.com/watch?v=VIDEO_ID
    if (hostname.includes('youtube.com')) {
      return parsedUrl.searchParams.get('v');
    }

    // Handle https://youtu.be/VIDEO_ID
    if (hostname.includes('youtu.be')) {
      return parsedUrl.pathname.split('/')[1];
    }

    return null;
  } catch (e) {
    console.log('error in extracting video id from url: ', e?.message);
    return null;
  }
}

module.exports = {
  CHUNK_DIR,
  TRANSCRIPT_DIR,
  CHUNK_LENGTH_SECONDS,
  extractChunk,
  transcribeAudioAzure,
  cleanChunksAndTranscriptFile,
  publishTranscript,
  cleanTranscript,
  markVideoLive,
  getYouTubeVideoId,
};
