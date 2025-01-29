"use client";
import React, { useState } from "react";

export default function Home() {
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [message, setMessage] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage("Processing...");

    try {
      const response = await fetch("/api/generateAndEmail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year, month })
      });

      if (!response.ok) {
        // If the serverless route returned an error status
        const errorData = await response.json();
        throw new Error(errorData.message || "Unknown error");
      }

      const data = await response.json();
      if (data.success) {
        setMessage("PDFs generated and emailed successfully!");
      } else {
        setMessage("Failed to send PDFs.");
      }
    } catch (error) {
      setMessage(`An error occurred: ${error.message}`);
    }
  };

  return (
    <div style={{ margin: "2rem" }}>
      <h1>Generate & Email PDFs</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="month">Month (1-12): </label>
          <input
            id="month"
            type="number"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            required
            min="1"
            max="12"
          />
        </div>
        <div>
          <label htmlFor="year">Year (e.g., 2025): </label>
          <input
            id="year"
            type="number"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            required
            min="2000"
          />
        </div>
        <button type="submit" style={{ marginTop: "1rem" }}>
          Generate & Email PDFs
        </button>
      </form>

      {message && (
        <p style={{ marginTop: "1rem", color: "blue" }}>{message}</p>
      )}
    </div>
  );
}
