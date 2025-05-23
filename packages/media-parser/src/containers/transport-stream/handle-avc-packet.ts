import {convertAudioOrVideoSampleToWebCodecsTimestamps} from '../../convert-audio-or-video-sample';
import type {Track} from '../../get-tracks';
import type {LogLevel} from '../../log';
import {registerVideoTrack} from '../../register-track';
import type {CallbacksState} from '../../state/sample-callbacks';
import type {TransportStreamState} from '../../state/transport-stream/transport-stream';
import type {
	AudioOrVideoSample,
	OnVideoTrack,
} from '../../webcodec-sample-types';
import {getCodecStringFromSpsAndPps} from '../avc/codec-string';
import {createSpsPpsData} from '../avc/create-sps-pps-data';
import {
	getDimensionsFromSps,
	getSampleAspectRatioFromSps,
	getVideoColorFromSps,
} from '../avc/interpret-sps';
import {getKeyFrameOrDeltaFromAvcInfo} from '../avc/key';
import {parseAvc} from '../avc/parse-avc';
import {getSpsAndPps} from '../avc/sps-and-pps';
import type {TransportStreamPacketBuffer} from './process-stream-buffers';

export const MPEG_TIMESCALE = 90000;

export const handleAvcPacket = async ({
	streamBuffer,
	programId,
	offset,
	sampleCallbacks,
	logLevel,
	onVideoTrack,
	transportStream,
	makeSamplesStartAtZero,
}: {
	streamBuffer: TransportStreamPacketBuffer;
	programId: number;
	offset: number;
	sampleCallbacks: CallbacksState;
	logLevel: LogLevel;
	onVideoTrack: OnVideoTrack | null;
	transportStream: TransportStreamState;
	makeSamplesStartAtZero: boolean;
}) => {
	const avc = parseAvc(streamBuffer.getBuffer());
	const isTrackRegistered = sampleCallbacks.tracks.getTracks().find((t) => {
		return t.trackId === programId;
	});
	if (!isTrackRegistered) {
		const spsAndPps = getSpsAndPps(avc);
		const dimensions = getDimensionsFromSps(spsAndPps.sps.spsData);
		const sampleAspectRatio = getSampleAspectRatioFromSps(
			spsAndPps.sps.spsData,
		);
		const startOffset = makeSamplesStartAtZero
			? Math.min(
					streamBuffer.pesHeader.pts,
					streamBuffer.pesHeader.dts ?? Infinity,
				)
			: 0;
		transportStream.startOffset.setOffset({
			trackId: programId,
			newOffset: startOffset,
		});

		const track: Track = {
			m3uStreamFormat: null,
			rotation: 0,
			trackId: programId,
			type: 'video',
			timescale: MPEG_TIMESCALE,
			codec: getCodecStringFromSpsAndPps(spsAndPps.sps),
			codecPrivate: createSpsPpsData(spsAndPps),
			fps: null,
			codedWidth: dimensions.width,
			codedHeight: dimensions.height,
			height: dimensions.height,
			width: dimensions.width,
			displayAspectWidth: dimensions.width,
			displayAspectHeight: dimensions.height,
			trakBox: null,
			codecWithoutConfig: 'h264',
			description: undefined,
			sampleAspectRatio: {
				denominator: sampleAspectRatio.height,
				numerator: sampleAspectRatio.width,
			},
			color: getVideoColorFromSps(spsAndPps.sps.spsData),
		};

		await registerVideoTrack({
			track,
			container: 'transport-stream',
			logLevel,
			onVideoTrack,
			registerVideoSampleCallback: sampleCallbacks.registerVideoSampleCallback,
			tracks: sampleCallbacks.tracks,
		});
	}

	const type = getKeyFrameOrDeltaFromAvcInfo(avc);

	// sample for webcodecs needs to be in nano seconds
	const sample: AudioOrVideoSample = {
		cts:
			streamBuffer.pesHeader.pts -
			transportStream.startOffset.getOffset(programId),
		dts:
			(streamBuffer.pesHeader.dts ?? streamBuffer.pesHeader.pts) -
			transportStream.startOffset.getOffset(programId),
		timestamp:
			streamBuffer.pesHeader.pts -
			transportStream.startOffset.getOffset(programId),
		duration: undefined,
		data: streamBuffer.getBuffer(),
		trackId: programId,
		type,
		offset,
		timescale: MPEG_TIMESCALE,
	};

	if (type === 'key') {
		transportStream.observedPesHeaders.markPtsAsKeyframe(
			streamBuffer.pesHeader.pts,
		);
	}

	const videoSample = convertAudioOrVideoSampleToWebCodecsTimestamps({
		sample,
		timescale: MPEG_TIMESCALE,
	});

	await sampleCallbacks.onVideoSample(programId, videoSample);

	transportStream.lastEmittedSample.setLastEmittedSample(sample);
};
