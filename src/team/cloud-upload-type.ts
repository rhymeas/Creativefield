/** Some file pickers omit the MIME type; infer only known supported extensions. */
export function cloudUploadType(file:File):File {
 if(file.type && file.type!=='application/octet-stream')return file;
 const ext=file.name.toLowerCase().match(/\.([^.]+)$/)?.[1];
 const type:Record<string,string>={mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'};
 return ext&&type[ext]?new File([file],file.name,{type:type[ext],lastModified:file.lastModified}):file;
}
