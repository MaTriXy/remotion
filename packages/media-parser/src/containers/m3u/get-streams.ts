import type {Dimensions} from '../../get-dimensions';
import type {ParseMediaSrc} from '../../options';
import type {MediaParserStructureUnstable} from '../../parse-result';
import type {ReaderInterface} from '../../readers/reader';
import type {ParserState} from '../../state/parser-state';
import type {M3uMediaInfo} from './types';

export type M3uAssociatedPlaylist = {
	groupId: string;
	language: string | null;
	name: string | null;
	autoselect: boolean;
	default: boolean;
	channels: number | null;
	src: string;
	id: number;
	isAudio: boolean;
};

export type M3uStream = {
	src: string;
	bandwidth: number | null;
	averageBandwidth: number | null;
	resolution: Dimensions | null;
	codecs: string[] | null;
	id: number;
	associatedPlaylists: M3uAssociatedPlaylist[];
};

export const isIndependentSegments = (
	structure: MediaParserStructureUnstable | null,
): boolean => {
	if (structure === null || structure.type !== 'm3u') {
		return false;
	}

	return structure.boxes.some(
		(box) =>
			box.type === 'm3u-independent-segments' || box.type === 'm3u-stream-info',
	);
};

export const getM3uStreams = ({
	structure,
	originalSrc,
	readerInterface,
}: {
	structure: MediaParserStructureUnstable | null;
	originalSrc: ParseMediaSrc;
	readerInterface: ReaderInterface;
}): M3uStream[] | null => {
	if (structure === null || structure.type !== 'm3u') {
		return null;
	}

	const boxes: Omit<M3uStream, 'id'>[] = [];

	for (let i = 0; i < structure.boxes.length; i++) {
		const str = structure.boxes[i];
		if (str.type === 'm3u-stream-info') {
			const next = structure.boxes[i + 1];
			if (next.type !== 'm3u-text-value') {
				throw new Error('Expected m3u-text-value');
			}

			const associatedPlaylists: M3uAssociatedPlaylist[] = [];

			if (str.audio) {
				const match = structure.boxes.filter((box) => {
					return box.type === 'm3u-media-info' && box.groupId === str.audio;
				}) as M3uMediaInfo[];

				for (const audioTrack of match) {
					associatedPlaylists.push({
						autoselect: audioTrack.autoselect,
						channels: audioTrack.channels,
						default: audioTrack.default,
						groupId: audioTrack.groupId,
						language: audioTrack.language,
						name: audioTrack.name,
						src: readerInterface.createAdjacentFileSource(
							audioTrack.uri,
							originalSrc,
						),
						id: associatedPlaylists.length,
						isAudio: true,
					});
				}
			}

			boxes.push({
				src: readerInterface.createAdjacentFileSource(next.value, originalSrc),
				averageBandwidth: str.averageBandwidth,
				bandwidth: str.bandwidth,
				codecs: str.codecs,
				resolution: str.resolution,
				associatedPlaylists,
			});
		}
	}

	// Maybe this is already a playlist
	if (boxes.length === 0) {
		return null;
	}

	const sorted = boxes.slice().sort((a, b) => {
		const aResolution = a.resolution
			? a.resolution.width * a.resolution.height
			: 0;
		const bResolution = b.resolution
			? b.resolution.width * b.resolution.height
			: 0;
		if (aResolution === bResolution) {
			const bandwidthA = a.averageBandwidth ?? a.bandwidth ?? 0;
			const bandwidthB = b.averageBandwidth ?? b.bandwidth ?? 0;
			return bandwidthB - bandwidthA;
		}

		return bResolution - aResolution;
	});

	return sorted.map((box, index) => ({...box, id: index}));
};

export const m3uHasStreams = (state: ParserState): boolean => {
	const structure = state.structure.getStructureOrNull();

	if (!structure) {
		return false;
	}

	if (structure.type !== 'm3u') {
		return true;
	}

	return state.m3u.hasFinishedManifest();
};
