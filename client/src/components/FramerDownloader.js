import React, { useState } from 'react';
import './FramerDownloader.css';

const FramerDownloader = () => {
    const [url, setUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [downloadPath, setDownloadPath] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        setDownloadPath('');

        try {
            const response = await fetch('/api/download', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url }),
            });

            let data;
            const text = await response.text();
            if (!text) {
                throw new Error('Empty response from server');
            }
            try {
                data = JSON.parse(text);
            } catch (e) {
                throw new Error('Invalid JSON response from server');
            }

            if (!response.ok) {
                throw new Error(data.error || 'Failed to download the website');
            }

            setDownloadPath(data.zipFilePath);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleDownloadFiles = () => {
        if (downloadPath) {
            window.location.href = downloadPath;
        }
    };

    return (
        <div className="framer-downloader">
            <div className="container">
                <h1>Framer Website Downloader</h1>
                <p className="description">
                    Enter a Framer website URL to download its assets and content.
                </p>

                <form onSubmit={handleSubmit} className="download-form">
                    <div className="input-group">
                        <input
                            type="url"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="Enter Framer website URL"
                            required
                            className="url-input"
                        />
                        <button 
                            type="submit" 
                            disabled={loading}
                            className="download-button"
                        >
                            {loading ? 'Downloading...' : 'Download'}
                        </button>
                    </div>
                </form>

                {error && (
                    <div className="error-message">
                        {error}
                    </div>
                )}

                {downloadPath && (
                    <div className="success-message">
                        <p>Download complete! Your files are ready.</p>
                        <button 
                            onClick={handleDownloadFiles}
                            className="download-now-button"
                        >
                            Download Now
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default FramerDownloader; 