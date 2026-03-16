import { useState, useEffect } from "react";
import api from "@/services/api/client";
import { formatDate } from "@/utils/dateFormatter";

export default function Downloads() {
  const [downloads, setDownloads] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchDownloads();
  }, []);

  const fetchDownloads = async () => {
    try {
      setLoading(true);
      const response = await api.get("/downloads");
      setDownloads(response.data || []);
    } catch (err) {
      console.error("Error fetching downloads:", err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: "20px" }}>
      <h1>Downloads</h1>
      {loading ? (
        <p>Loading...</p>
      ) : (
        <div style={{ display: "grid", gap: "15px" }}>
          {downloads.map((item) => (
            <div key={item.id} style={{ padding: "15px", border: "1px solid #ddd", borderRadius: "8px" }}>
              <h3>{item.name}</h3>
              <p>Category: {item.category}</p>
              <p>Updated: {formatDate(item.updated_date)}</p>
              <a href={item.file_url} download style={{ color: "#007bff" }}>
                Download
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
