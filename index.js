const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion } = require("mongodb");

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.thvamxq.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const usersCollection = client.db("workHive").collection("users");

    // user  api
    // GET /best-workers
    app.get("/best-workers", async (req, res) => {
      try {
        const workers = await usersCollection
          .find({ role: "Worker" })
          .sort({ coins: -1 })
          .limit(6)
          .project({ name: 1, email: 1, photo: 1, coins: 1 })
          .toArray();

        res.json(workers);
      } catch (error) {
        console.error("Error fetching best workers:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // ✅ GET /users/:email - Fetch a single user by email
    app.get("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }

        res.json(user);
      } catch (error) {
        console.error("GET /users/:email error:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // ✅ POST /users - Register new user
    app.post("/users", async (req, res) => {
      try {
        const { name, email, photo, role, created_at, last_log_in } = req.body;

        // Check if user already exists
        const existingUser = await usersCollection.findOne({ email });

        if (existingUser) {
          return res.status(409).json({ message: "User already exists" });
        }

        // Assign coins based on role
        const coins = role === "Buyer" ? 50 : 10;

        const newUser = {
          name,
          email,
          photo,
          role,
          coins,
          created_at,
          last_log_in,
        };

        const result = await usersCollection.insertOne(newUser);

        res.status(201).json({
          message: "User registered successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("server is running");
});

app.listen(port, () => {
  console.log(`server is running on port ${port}`);
});
