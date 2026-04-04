require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const reportRoutes = require("./routes/report");
app.use("/review", reportRoutes);
const webhookRoutes = require("./routes/webhook");
app.use("/webhook", webhookRoutes);
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
