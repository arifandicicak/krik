import express from "express";
import { createServer as createViteServer } from "vite";
import session from "express-session";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  const isProd = process.env.NODE_ENV === "production";
  const isVercel = !!process.env.VERCEL;

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  
  // Middleware to ensure a persistent user ID via cookie (1 year) or header
  app.use(async (req, res, next) => {
    let userId = (req.headers['x-user-id'] as string) || req.cookies.user_id;
    
    if (!userId) {
      userId = uuidv4();
    }

    // Ensure cookie is set and matches
    if (userId !== req.cookies.user_id) {
      res.cookie('user_id', userId, {
        maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
        httpOnly: true,
        secure: isProd || !!process.env.APP_URL,
        sameSite: (isProd || !!process.env.APP_URL) ? "none" : "lax",
      });
    }
    
    // Ensure user exists in Supabase
    try {
      const { data: existingUser } = await supabase.from('users').select('id').eq('id', userId).single();
      if (!existingUser) {
        await supabase.from('users').insert([{ id: userId, created_at: new Date().toISOString() }]);
      }
    } catch (e) {
      console.error("User check/create error:", e);
    }
    
    (req as any).userId = userId;
    next();
  });

  const getUserId = (req: any) => {
    return req.headers['x-user-id'] || req.userId;
  };

  // Auth Routes (Removed Google Auth)
  app.get("/api/me", async (req, res) => {
    const userId = getUserId(req);
    const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
    res.json({ user });
  });

  // Chat Routes
  app.get("/api/sessions", async (req, res) => {
    const userId = getUserId(req);
    
    const { data: userSessions, error: sessionError } = await supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (sessionError) return res.status(500).json({ error: sessionError.message });

    const sessionsWithMessages = await Promise.all((userSessions || []).map(async (s: any) => {
      const { data: sessionMessages } = await supabase
        .from('messages')
        .select('*')
        .eq('session_id', s.id)
        .order('timestamp', { ascending: true });

      return {
        id: s.id,
        title: s.title,
        createdAt: s.created_at,
        messages: (sessionMessages || []).map((m: any) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          imageData: m.image_data,
          timestamp: m.timestamp
        }))
      };
    }));
    
    res.json(sessionsWithMessages);
  });

  app.post("/api/sessions", async (req, res) => {
    const userId = getUserId(req);
    const { id, title, createdAt } = req.body;
    
    const { error } = await supabase
      .from('sessions')
      .insert([{ id, user_id: userId, title, created_at: new Date(createdAt).toISOString() }]);

    if (error) {
      console.error("Create session error:", error);
      const errorMessage = error.message || "Unknown database error";
      return res.status(500).json({ 
        error: errorMessage,
        hint: (errorMessage.includes("schema cache") || errorMessage.includes("relation \"sessions\" does not exist"))
          ? "The 'sessions' table is missing. Please run the setup SQL in Supabase." 
          : undefined
      });
    }
    res.json({ success: true });
  });

  app.delete("/api/sessions", async (req, res) => {
    const userId = getUserId(req);
    console.log(`Bulk deleting all sessions for user ${userId}`);
    
    try {
      // 1. Get all session IDs to delete messages
      const { data: userSessions } = await supabase
        .from('sessions')
        .select('id')
        .eq('user_id', userId);
      
      if (userSessions && userSessions.length > 0) {
        const sessionIds = userSessions.map(s => s.id);
        
        // 2. Delete all messages for these sessions
        const { error: msgError } = await supabase.from('messages').delete().in('session_id', sessionIds);
        if (msgError) console.error("Bulk delete messages error:", msgError);
      }
      
      // 3. Delete all sessions for this user directly
      const { error: sessionError } = await supabase.from('sessions').delete().eq('user_id', userId);
      if (sessionError) throw sessionError;
      
      res.json({ success: true });
    } catch (err: any) {
      console.error("Bulk delete error details:", err);
      const errorMessage = err.message || "Unknown database error";
      res.status(500).json({ 
        error: errorMessage,
        hint: (errorMessage.includes("schema cache") || errorMessage.includes("relation \"sessions\" does not exist"))
          ? "The database tables are missing. Please run the setup SQL in Supabase." 
          : undefined
      });
    }
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    const userId = getUserId(req);
    const { id } = req.params;
    console.log(`Deleting session ${id} for user ${userId}`);
    
    try {
      // Delete messages first to handle foreign key constraint
      // Try both string and numeric ID if applicable
      const idAsNum = id.match(/^\d+$/) ? parseInt(id) : null;
      
      if (idAsNum !== null) {
        await supabase.from('messages').delete().eq('session_id', idAsNum);
        await supabase.from('sessions').delete().match({ id: idAsNum, user_id: userId });
      }
      
      await supabase.from('messages').delete().eq('session_id', id);
      const { error: sessionError } = await supabase
        .from('sessions')
        .delete()
        .match({ id: id, user_id: userId });

      if (sessionError) {
        console.error("Error deleting session:", sessionError);
        return res.status(500).json({ error: sessionError.message });
      }
      
      console.log(`Successfully deleted session ${id}`);
      res.json({ success: true });
    } catch (err: any) {
      console.error("Delete session error details:", err);
      const errorMessage = err.message || "Unknown database error";
      res.status(500).json({ 
        error: errorMessage,
        hint: (errorMessage.includes("schema cache") || errorMessage.includes("relation \"sessions\" does not exist"))
          ? "The database tables are missing. Please run the setup SQL in Supabase." 
          : undefined
      });
    }
  });

  app.patch("/api/sessions/:id/title", async (req, res) => {
    const userId = getUserId(req);
    const { id } = req.params;
    const { title } = req.body;
    console.log(`Renaming session ${id} to "${title}" for user ${userId}`);
    
    try {
      const idAsNum = id.match(/^\d+$/) ? parseInt(id) : null;
      
      let query = supabase.from('sessions').update({ title }).eq('user_id', userId);
      
      if (idAsNum !== null) {
        // Try matching either numeric or string ID
        const { error } = await supabase
          .from('sessions')
          .update({ title })
          .match({ user_id: userId })
          .or(`id.eq.${id},id.eq.${idAsNum}`);
        
        if (error) throw error;
      } else {
        const { error } = await query.eq('id', id);
        if (error) throw error;
      }
      
      res.json({ success: true });
    } catch (err: any) {
      console.error("Rename error details:", err);
      const errorMessage = err.message || "Unknown database error";
      res.status(500).json({ 
        error: errorMessage,
        hint: (errorMessage.includes("schema cache") || errorMessage.includes("relation \"sessions\" does not exist")) 
          ? "The 'sessions' table is missing. You need to run the setup SQL in your Supabase dashboard." 
          : undefined
      });
    }
  });

  app.post("/api/messages", async (req, res) => {
    const userId = getUserId(req);
    const { id, sessionId, role, text, timestamp, sessionTitle, imageData } = req.body;
    
    if (sessionTitle) {
      const sessionIdAsNum = String(sessionId).match(/^\d+$/) ? parseInt(String(sessionId)) : null;
      if (sessionIdAsNum !== null) {
        await supabase
          .from('sessions')
          .update({ title: sessionTitle })
          .match({ user_id: userId })
          .or(`id.eq.${sessionId},id.eq.${sessionIdAsNum}`);
      } else {
        await supabase
          .from('sessions')
          .update({ title: sessionTitle })
          .match({ id: sessionId, user_id: userId });
      }
    }

    const { error } = await supabase
      .from('messages')
      .insert([{ 
        id, 
        session_id: sessionId, 
        role, 
        text, 
        timestamp: new Date(timestamp).toISOString(), 
        image_data: imageData || null 
      }]);

    if (error) {
      console.error("Create message error:", error);
      const errorMessage = error.message || "Unknown database error";
      return res.status(500).json({ 
        error: errorMessage,
        hint: (errorMessage.includes("schema cache") || errorMessage.includes("relation \"messages\" does not exist"))
          ? "The 'messages' table is missing. Please run the setup SQL in Supabase." 
          : undefined
      });
    }
    res.json({ success: true });
  });

  app.delete("/api/messages/:id", async (req, res) => {
    const userId = getUserId(req);
    const { id } = req.params;
    
    // Verify ownership via join or subquery if needed, but here we assume session check
    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  app.delete("/api/sessions/:sessionId/messages", async (req, res) => {
    const userId = getUserId(req);
    const { sessionId } = req.params;
    console.log(`Clearing messages for session ${sessionId} (User: ${userId})`);
    
    try {
      const sessionIdAsNum = sessionId.match(/^\d+$/) ? parseInt(sessionId) : null;
      
      // Verify session ownership
      let query = supabase.from('sessions').select('id').eq('user_id', userId);
      if (sessionIdAsNum !== null) {
        query = query.or(`id.eq.${sessionId},id.eq.${sessionIdAsNum}`);
      } else {
        query = query.eq('id', sessionId);
      }
      
      const { data: session, error: fetchError } = await query.single();

      if (fetchError || !session) {
        console.error("Session not found or ownership mismatch:", fetchError);
        return res.status(404).json({ error: "Session not found" });
      }

      // Delete messages for both string and numeric session_id
      if (sessionIdAsNum !== null) {
        await supabase.from('messages').delete().eq('session_id', sessionIdAsNum);
      }
      const { error: deleteError } = await supabase
        .from('messages')
        .delete()
        .eq('session_id', sessionId);
      
      if (deleteError) throw deleteError;
      
      res.json({ success: true });
    } catch (err: any) {
      console.error("Clear messages error:", err);
      const errorMessage = err.message || "Unknown database error";
      res.status(500).json({ 
        error: errorMessage,
        hint: (errorMessage.includes("schema cache") || errorMessage.includes("relation \"messages\" does not exist"))
          ? "The 'messages' table is missing. Please run the setup SQL in Supabase." 
          : undefined
      });
    }
  });

  // Vite middleware for development
  if (!isProd && !isVercel) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (isProd) {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      // Skip API routes
      if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
        return res.status(404).json({ error: "Not found" });
      }
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  // Only listen if not running as a serverless function (Vercel)
  if (!isVercel) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }

  return app;
}

// Export the app for Vercel
export const appPromise = startServer();
export default appPromise;
