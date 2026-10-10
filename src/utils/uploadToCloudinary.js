import fs from "fs";
import cloudinary from "../config/cloudinary.js";

// Uploads a file to Cloudinary and returns the URL and public ID
export async function uploadToCloudinary(localFilePath, folder = "my-app") {
  try {
    // Upload to Cloudinary 
    const result = await cloudinary.uploader.upload(localFilePath, { folder, resource_type: "auto" });  
    fs.unlinkSync(localFilePath);                                   // Delete the temporary local file after upload    
    return { url: result.secure_url, publicId: result.public_id };  // Return the URL and public ID
  } catch (error) {
    // Ensure temp file removed even if upload fails
    if (fs.existsSync(localFilePath)) { fs.unlinkSync(localFilePath); }
    throw error;
  }
}


// Deletes a file from Cloudinary by its public ID (ID is stored in MessageAttachment.publicId when the file was uploaded)
export async function deleteFromCloudinary(publicId) {
  try {
    await cloudinary.uploader.destroy(publicId);    // Delete from Cloudinary
  } catch (error) {
    // Log but don't throw — a failed Cloudinary delete should never block a DB delete
    console.error(`Failed to delete Cloudinary asset (${publicId}):`, error.message);
  }
}