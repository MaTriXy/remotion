import type {BufferIterator} from '../../iterator/buffer-iterator';
import {registerAudioTrack, registerVideoTrack} from '../../register-track';
import type {AudioOrVideoSample} from '../../webcodec-sample-types';
import {getSampleFromBlock} from './get-sample-from-block';
import {
	getTrack,
	NO_CODEC_PRIVATE_SHOULD_BE_DERIVED_FROM_SPS,
} from './make-track';
import type {PossibleEbml} from './segments/all-segments';
import {ebmlMap} from './segments/all-segments';
import type {WebmRequiredStatesForProcessing} from './state-for-processing';

export type Prettify<T> = {
	[K in keyof T]: T[K];
} & {};

export const parseEbml = async (
	iterator: BufferIterator,
	statesForProcessing: WebmRequiredStatesForProcessing | null,
): Promise<Prettify<PossibleEbml>> => {
	const hex = iterator.getMatroskaSegmentId();
	if (hex === null) {
		throw new Error(
			'Not enough bytes left to parse EBML - this should not happen',
		);
	}

	const hasInMap = ebmlMap[hex as keyof typeof ebmlMap];
	if (!hasInMap) {
		throw new Error(
			`Don't know how to parse EBML hex ID ${JSON.stringify(hex)}`,
		);
	}

	const off = iterator.counter.getOffset();
	const size = iterator.getVint();
	const minVintWidth = iterator.counter.getOffset() - off;

	if (size === null) {
		throw new Error(
			'Not enough bytes left to parse EBML - this should not happen',
		);
	}

	if (hasInMap.type === 'uint') {
		const beforeUintOffset = iterator.counter.getOffset();
		const value = size === 0 ? 0 : iterator.getUint(size);

		const {name} = hasInMap;

		return {
			// To work around TS limit
			type: name as 'SeekPosition',
			value: {
				value,
				byteLength: iterator.counter.getOffset() - beforeUintOffset,
			},
			minVintWidth,
		};
	}

	if (hasInMap.type === 'string') {
		const value = iterator.getByteString(size, true);

		return {
			type: hasInMap.name,
			value,
			minVintWidth,
		};
	}

	if (hasInMap.type === 'float') {
		const value =
			size === 0
				? 0.0
				: size === 4
					? iterator.getFloat32()
					: iterator.getFloat64();

		return {
			type: hasInMap.name,
			value: {
				value,
				size: size === 4 ? '32' : '64',
			},
			minVintWidth,
		};
	}

	if (hasInMap.type === 'hex-string') {
		return {
			type: hasInMap.name,
			value:
				'0x' +
				[...iterator.getSlice(size)]
					.map((b) => b.toString(16).padStart(2, '0'))
					.join('')
					.replace(new RegExp('^' + hex), ''),
			minVintWidth,
		};
	}

	if (hasInMap.type === 'uint8array') {
		return {
			type: hasInMap.name,
			value: iterator.getSlice(size),
			minVintWidth,
		};
	}

	if (hasInMap.type === 'children') {
		const children: PossibleEbml[] = [];
		const startOffset = iterator.counter.getOffset();

		while (true) {
			if (size === 0) {
				break;
			}

			const offset = iterator.counter.getOffset();
			const value = await parseEbml(iterator, statesForProcessing);

			const remapped = statesForProcessing
				? // eslint-disable-next-line @typescript-eslint/no-use-before-define
					await postprocessEbml({
						offset,
						ebml: value,
						statesForProcessing,
					})
				: value;
			children.push(remapped);

			const offsetNow = iterator.counter.getOffset();

			if (offsetNow - startOffset > size) {
				throw new Error(
					`Offset ${offsetNow - startOffset} is larger than the length of the hex ${size}`,
				);
			}

			if (offsetNow - startOffset === size) {
				break;
			}
		}

		return {type: hasInMap.name, value: children, minVintWidth};
	}

	// @ts-expect-error
	throw new Error(`Unknown segment type ${hasInMap.type}`);
};

export const postprocessEbml = async ({
	offset,
	ebml,
	statesForProcessing: {
		webmState,
		callbacks,
		logLevel,
		onAudioTrack,
		onVideoTrack,
		structureState,
	},
}: {
	offset: number;
	ebml: Prettify<PossibleEbml>;
	statesForProcessing: WebmRequiredStatesForProcessing;
}): Promise<Prettify<PossibleEbml>> => {
	if (ebml.type === 'TimestampScale') {
		webmState.setTimescale(ebml.value.value);
	}

	if (ebml.type === 'Tracks') {
		callbacks.tracks.setIsDone(logLevel);
	}

	if (ebml.type === 'TrackEntry') {
		webmState.onTrackEntrySegment(ebml);

		const track = getTrack({
			track: ebml,
			timescale: webmState.getTimescale(),
		});

		if (track && track.type === 'audio') {
			await registerAudioTrack({
				track,
				container: 'webm',
				registerAudioSampleCallback: callbacks.registerAudioSampleCallback,
				tracks: callbacks.tracks,
				logLevel,
				onAudioTrack,
			});
		}

		if (track && track.type === 'video') {
			if (track.codec !== NO_CODEC_PRIVATE_SHOULD_BE_DERIVED_FROM_SPS) {
				await registerVideoTrack({
					track,
					container: 'webm',
					logLevel,
					onVideoTrack,
					registerVideoSampleCallback: callbacks.registerVideoSampleCallback,
					tracks: callbacks.tracks,
				});
			}
		}
	}

	if (ebml.type === 'Timestamp') {
		webmState.setTimestampOffset(offset, ebml.value.value);
	}

	if (ebml.type === 'Block' || ebml.type === 'SimpleBlock') {
		const sample = await getSampleFromBlock({
			ebml,
			webmState,
			offset,
			structureState,
			callbacks,
			logLevel,
			onVideoTrack,
		});

		if (sample.type === 'video-sample') {
			await callbacks.onVideoSample(
				sample.videoSample.trackId,
				sample.videoSample,
			);

			return {
				type: 'Block',
				value: new Uint8Array([]),
				minVintWidth: ebml.minVintWidth,
			};
		}

		if (sample.type === 'audio-sample') {
			await callbacks.onAudioSample(
				sample.audioSample.trackId,
				sample.audioSample,
			);

			return {
				type: 'Block',
				value: new Uint8Array([]),
				minVintWidth: ebml.minVintWidth,
			};
		}

		if (sample.type === 'no-sample') {
			return {
				type: 'Block',
				value: new Uint8Array([]),
				minVintWidth: ebml.minVintWidth,
			};
		}
	}

	if (ebml.type === 'BlockGroup') {
		// Blocks don't have information about keyframes.
		// https://ffmpeg.org/pipermail/ffmpeg-devel/2015-June/173825.html
		// "For Blocks, keyframes is
		// inferred by the absence of ReferenceBlock element (as done by matroskadec).""

		const block = ebml.value.find(
			(c) => c.type === 'SimpleBlock' || c.type === 'Block',
		);
		if (!block || (block.type !== 'SimpleBlock' && block.type !== 'Block')) {
			throw new Error('Expected block segment');
		}

		const hasReferenceBlock = ebml.value.find(
			(c) => c.type === 'ReferenceBlock',
		);

		const sample =
			block.value.length === 0
				? null
				: await getSampleFromBlock({
						ebml: block,
						webmState,
						offset,
						structureState,
						callbacks,
						logLevel,
						onVideoTrack,
					});

		if (sample && sample.type === 'partial-video-sample') {
			const completeFrame: AudioOrVideoSample = {
				...sample.partialVideoSample,
				type: hasReferenceBlock ? 'delta' : 'key',
			};

			await callbacks.onVideoSample(
				sample.partialVideoSample.trackId,
				completeFrame,
			);
		}

		return {
			type: 'BlockGroup',
			value: [],
			minVintWidth: ebml.minVintWidth,
		};
	}

	return ebml;
};
