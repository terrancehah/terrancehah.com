import { useEffect, useState } from 'react';

const videos = [
  '/videos/Dubai_Night_1080P_20X_compressed.mp4',
  '/videos/London_Skyline_720P_8X_compressed.mp4',
  '/videos/Patagonia_Lake_720P_20X_compressed.mp4',
  '/videos/Grand_Canyon_720P_8X_compresed.mp4'
];

export function useBackgroundVideo() {
  const [currentVideo, setCurrentVideo] = useState(videos[0]);

  useEffect(() => {
    // Set up video ended event handler
    const handleVideoEnd = () => {
      const currentIndex = videos.indexOf(currentVideo);
      const nextIndex = (currentIndex + 1) % videos.length;
      setCurrentVideo(videos[nextIndex]);
    };

    const videoElement = document.getElementById('backgroundVideo') as HTMLVideoElement;
    if (videoElement) {
      videoElement.addEventListener('ended', handleVideoEnd);
      
      // Handle video loading error
      const handleError = () => {
        console.error('Video failed to load:', currentVideo);
        handleVideoEnd(); // Try next video
      };
      videoElement.addEventListener('error', handleError);

      return () => {
        videoElement.removeEventListener('ended', handleVideoEnd);
        videoElement.removeEventListener('error', handleError);
      };
    }
  }, [currentVideo]);

  return currentVideo;
}
