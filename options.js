document.getElementById('requestBtn').addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Permission was granted, stop the stream immediately.
        stream.getTracks().forEach(track => track.stop());
        
        const statusEl = document.getElementById('status');
        statusEl.textContent = "Mic access granted! You can now close this tab and use Bropilot.";
        statusEl.style.color = "green";
        document.getElementById('requestBtn').style.display = 'none';
    } catch (err) {
        const statusEl = document.getElementById('status');
        statusEl.textContent = "Access denied. Please check your browser's site settings to allow microphone.";
        statusEl.style.color = "red";
    }
});
